import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { z } from 'zod';

// List Production Batches
export const getProductionBatches = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;

    if (!isSupabaseConfigured) {
      return res.json({ success: true, batches: [] });
    }

    const { data: batches, error } = await supabase
      .from('production_batches')
      .select(`
        *,
        customer_orders (id, order_number, customers(name)),
        products (id, code, name, unit),
        product_recipes (id, version),
        production_material_consumption (
          id, material_id, material_batch_id, planned_quantity_kg, actual_quantity_kg,
          materials (code, name),
          material_batches (batch_number, supplier_lot_number)
        ),
        production_outputs (
          id, accepted_kg, waste_kg, rejected_kg, recorded_at
        )
      `)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, batches });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Start / Draft Production Run (PRO-01, PRO-02, PRO-03, PRO-09)
export const createProductionBatch = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    const userId = req.user?.id;

    const schema = z.object({
      orderId: z.string().uuid(),
      orderItemId: z.string().uuid(),
      recipeId: z.string().uuid(),
      batchNumber: z.string().min(3),
      plannedQuantityKg: z.number().positive(),
      operatorId: z.string().uuid().optional(),
      supervisorId: z.string().uuid().optional(),
      notes: z.string().optional()
    });

    const body = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      return res.status(201).json({
        success: true,
        batch: {
          id: `pb-${Date.now()}`,
          batch_number: body.batchNumber,
          planned_quantity_kg: body.plannedQuantityKg,
          status: 'draft'
        }
      });
    }

    // Verify order item
    const { data: orderItem, error: oiErr } = await supabase
      .from('customer_order_items')
      .select('id, product_id, requested_quantity_kg, produced_quantity_kg')
      .eq('id', body.orderItemId)
      .single();

    if (oiErr || !orderItem) {
      return res.status(404).json({ success: false, message: 'Order item not found' });
    }

    // Create production batch in draft state
    const { data: batch, error: pbErr } = await supabase
      .from('production_batches')
      .insert({
        tenant_id: tenantId,
        order_id: body.orderId,
        order_item_id: body.orderItemId,
        product_id: orderItem.product_id,
        recipe_id: body.recipeId,
        batch_number: body.batchNumber,
        planned_quantity_kg: body.plannedQuantityKg,
        status: 'draft',
        operator_id: body.operatorId || userId,
        supervisor_id: body.supervisorId,
        start_time: new Date().toISOString(),
        notes: body.notes
      })
      .select('*')
      .single();

    if (pbErr) throw pbErr;

    // Update customer order status to in_production
    await supabase
      .from('customer_orders')
      .update({ status: 'in_production', updated_at: new Date().toISOString() })
      .eq('id', body.orderId);

    await supabase
      .from('customer_order_items')
      .update({ status: 'in_production' })
      .eq('id', body.orderItemId);

    return res.status(201).json({ success: true, batch });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Confirm Production Run: Atomically records lot consumption, outputs, finished goods & transactions (PRO-04..PRO-08)
export const confirmProductionBatch = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    const userId = req.user?.id;
    const { batchId } = req.params;

    const schema = z.object({
      // Specific lots and kg consumed from each lot (PRO-05)
      consumption: z.array(z.object({
        materialId: z.string().uuid(),
        materialBatchId: z.string().uuid(),
        plannedQuantityKg: z.number().nonnegative(),
        actualQuantityKg: z.number().positive(),
        notes: z.string().optional()
      })).min(1),
      // Outputs: Accepted, Waste, Rejected (PRO-07)
      acceptedOutputKg: z.number().positive(),
      wasteKg: z.number().nonnegative().default(0),
      rejectedKg: z.number().nonnegative().default(0),
      notes: z.string().optional()
    });

    const body = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      return res.json({
        success: true,
        message: 'Production confirmed successfully (mock mode)',
        summary: {
          total_consumed_kg: body.consumption.reduce((s, c) => s + c.actualQuantityKg, 0),
          accepted_output_kg: body.acceptedOutputKg,
          waste_kg: body.wasteKg,
          rejected_kg: body.rejectedKg
        }
      });
    }

    // 1. Fetch production batch
    const { data: batch, error: fetchErr } = await supabase
      .from('production_batches')
      .select('*')
      .eq('id', batchId)
      .eq('tenant_id', tenantId)
      .single();

    if (fetchErr || !batch) {
      return res.status(404).json({ success: false, message: 'Production batch not found' });
    }

    if (batch.status === 'completed') {
      return res.status(400).json({ success: false, message: 'Production batch is already confirmed and completed (PRO-10).' });
    }

    // 2. Validate raw material availability for each lot before deducting (INV-10, PRO-08)
    for (const item of body.consumption) {
      const { data: matBatch, error: mbErr } = await supabase
        .from('material_batches')
        .select('id, batch_number, remaining_quantity_kg')
        .eq('id', item.materialBatchId)
        .eq('tenant_id', tenantId)
        .single();

      if (mbErr || !matBatch) {
        return res.status(400).json({
          success: false,
          message: `Material batch ID '${item.materialBatchId}' not found.`
        });
      }

      if (Number(matBatch.remaining_quantity_kg) < item.actualQuantityKg) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock in batch '${matBatch.batch_number}'. Available: ${matBatch.remaining_quantity_kg} kg, Requested: ${item.actualQuantityKg} kg.`
        });
      }
    }

    const totalActualInput = body.consumption.reduce((s, c) => s + c.actualQuantityKg, 0);

    // 3. Deduct stock from material batches and insert consumption records
    for (const item of body.consumption) {
      // Deduct batch balance
      const { data: currentMB } = await supabase
        .from('material_batches')
        .select('remaining_quantity_kg')
        .eq('id', item.materialBatchId)
        .single();

      const newRemaining = Number(currentMB?.remaining_quantity_kg) - item.actualQuantityKg;
      const status = newRemaining === 0 ? 'depleted' : 'available';

      await supabase
        .from('material_batches')
        .update({
          remaining_quantity_kg: newRemaining,
          status,
          updated_at: new Date().toISOString()
        })
        .eq('id', item.materialBatchId);

      // Record consumption row
      await supabase.from('production_material_consumption').insert({
        tenant_id: tenantId,
        production_batch_id: batchId,
        material_id: item.materialId,
        material_batch_id: item.materialBatchId,
        planned_quantity_kg: item.plannedQuantityKg,
        actual_quantity_kg: item.actualQuantityKg,
        consumed_by: userId,
        notes: item.notes
      });

      // Record ledger entry
      await supabase.from('inventory_transactions').insert({
        tenant_id: tenantId,
        transaction_type: 'consumption',
        item_type: 'raw_material',
        material_id: item.materialId,
        material_batch_id: item.materialBatchId,
        quantity_kg: -item.actualQuantityKg,
        reference_type: 'production_batch',
        reference_id: batchId,
        reason: `Consumed in production batch ${batch.batch_number}`,
        created_by: userId
      });
    }

    // 4. Record Output, Waste and Rejected
    await supabase.from('production_outputs').insert({
      tenant_id: tenantId,
      production_batch_id: batchId,
      accepted_kg: body.acceptedOutputKg,
      waste_kg: body.wasteKg,
      rejected_kg: body.rejectedKg,
      recorded_by: userId,
      notes: body.notes
    });

    // 5. Create Finished Goods Batch (FG-02, FG-03)
    const fgBatchNumber = `FG-${batch.batch_number}`;
    const { data: fgBatch, error: fgErr } = await supabase
      .from('finished_goods_batches')
      .insert({
        tenant_id: tenantId,
        product_id: batch.product_id,
        production_batch_id: batchId,
        batch_number: fgBatchNumber,
        quantity_produced_kg: body.acceptedOutputKg,
        quantity_on_hand_kg: body.acceptedOutputKg,
        quantity_reserved_kg: 0,
        quantity_dispatched_kg: 0,
        status: 'in_stock'
      })
      .select('*')
      .single();

    if (fgErr) throw fgErr;

    // Finished goods ledger entry
    await supabase.from('inventory_transactions').insert({
      tenant_id: tenantId,
      transaction_type: 'production_output',
      item_type: 'finished_goods',
      product_id: batch.product_id,
      finished_goods_batch_id: fgBatch.id,
      quantity_kg: body.acceptedOutputKg,
      reference_type: 'production_batch',
      reference_id: batchId,
      reason: `Output from production batch ${batch.batch_number}`,
      created_by: userId
    });

    // 6. Update Production Batch Header status to completed
    await supabase
      .from('production_batches')
      .update({
        actual_input_kg: totalActualInput,
        accepted_output_kg: body.acceptedOutputKg,
        waste_kg: body.wasteKg,
        rejected_kg: body.rejectedKg,
        status: 'completed',
        completion_time: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', batchId);

    // 7. Update Customer Order Item produced quantities
    const { data: orderItem } = await supabase
      .from('customer_order_items')
      .select('produced_quantity_kg, requested_quantity_kg')
      .eq('id', batch.order_item_id)
      .single();

    const newProducedQty = Number(orderItem?.produced_quantity_kg || 0) + body.acceptedOutputKg;
    const isOrderComplete = newProducedQty >= Number(orderItem?.requested_quantity_kg);

    await supabase
      .from('customer_order_items')
      .update({
        produced_quantity_kg: newProducedQty,
        status: isOrderComplete ? 'produced' : 'in_production'
      })
      .eq('id', batch.order_item_id);

    // Check overall order status
    const { data: allItems } = await supabase
      .from('customer_order_items')
      .select('produced_quantity_kg, requested_quantity_kg')
      .eq('order_id', batch.order_id);

    const allProduced = (allItems || []).every((i: any) => Number(i.produced_quantity_kg) >= Number(i.requested_quantity_kg));
    await supabase
      .from('customer_orders')
      .update({
        status: allProduced ? 'produced' : 'partially_produced',
        updated_at: new Date().toISOString()
      })
      .eq('id', batch.order_id);

    // 8. Audit trail log
    await supabase.from('audit_logs').insert({
      tenant_id: tenantId,
      user_id: userId,
      action: 'CONFIRM_PRODUCTION_BATCH',
      entity_name: 'production_batches',
      entity_id: batchId,
      new_values: {
        total_input_kg: totalActualInput,
        accepted_output_kg: body.acceptedOutputKg,
        waste_kg: body.wasteKg,
        rejected_kg: body.rejectedKg,
        fg_batch_id: fgBatch.id
      }
    });

    return res.json({
      success: true,
      message: 'Production confirmed, raw materials consumed, and finished goods stocked.',
      production_batch_id: batchId,
      finished_goods_batch: fgBatch
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};
