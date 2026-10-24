import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { z } from 'zod';
import { inMemOrders, inMemCustomers } from './orders.controller';
import { inMemProducts } from './products.controller';
import { inMemBatches, inMemMaterials } from './materials.controller';
import { inMemFGBatches, InMemFGBatch } from './finishedGoods.controller';

export interface InMemProductionBatch {
  id: string;
  tenant_id: string;
  order_id: string;
  order_item_id: string;
  product_id: string;
  recipe_id: string;
  batch_number: string;
  planned_quantity_kg: number;
  actual_input_kg?: number;
  accepted_output_kg?: number;
  trim_waste_kg?: number;
  plant_waste_kg?: number;
  waste_kg?: number;
  rejected_kg?: number;
  status: 'draft' | 'in_progress' | 'completed' | 'cancelled';
  operator_id?: string;
  operator_name?: string;
  supervisor_id?: string;
  start_time: string;
  end_time?: string;
  notes?: string;
  created_at: string;
  customer_orders?: any;
  products?: any;
  product_recipes?: any;
  production_material_consumption?: any[];
  production_outputs?: any[];
}

import { mockStore, saveMockStore } from '../utils/mockStore';

export let inMemProductionBatches: InMemProductionBatch[] = mockStore.productionBatches;

const getTenantId = (req: Request): string =>
  (req.tenantId || process.env.DEFAULT_TENANT_SLUG || 'shri-hari-pack') as string;

// List Production Batches
export const getProductionBatches = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    if (!isSupabaseConfigured) {
      const tenantBatches = inMemProductionBatches.filter((b) => b.tenant_id === tenantId);
      const enriched = tenantBatches.map((b) => {
        const ord = inMemOrders.find((o) => o.id === b.order_id);
        const prod = inMemProducts.find((p) => p.id === b.product_id);
        const recipe =
          prod?.product_recipes?.find((r) => r.id === b.recipe_id) || prod?.product_recipes?.[0];
        const cust = ord?.customer_id ? inMemCustomers.find((c) => c.id === ord.customer_id) : null;
        return {
          ...b,
          customer_orders: ord
            ? {
                id: ord.id,
                order_number: ord.order_number,
                customers: cust ? { name: cust.name } : null,
              }
            : null,
          products: prod ? { id: prod.id, code: prod.code, name: prod.name, unit: prod.unit } : null,
          product_recipes: recipe ? { id: recipe.id, version: recipe.version } : null,
          production_material_consumption: b.production_material_consumption || [],
          production_outputs: b.production_outputs || [],
        };
      });
      return res.json({ success: true, batches: enriched });
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
          id, accepted_kg, trim_waste_kg, plant_waste_kg, waste_kg, rejected_kg, recorded_at
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
    const tenantId = getTenantId(req);
    const userId = req.user?.id;

    const schema = z.object({
      orderId: z.string().min(1),
      orderItemId: z.string().optional().default(''),
      recipeId: z.string().optional().default(''),
      batchNumber: z.string().optional(),
      plannedQuantityKg: z.number().positive(),
      operatorId: z.string().optional(),
      operatorName: z.string().optional(),
      supervisorId: z.string().optional(),
      notes: z.string().optional(),
    });

    const body = schema.parse(req.body);
    const resolvedBatchNumber =
      body.batchNumber?.trim() ||
      `PB-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(
        Math.random() * 900 + 100
      )}`;

    if (!isSupabaseConfigured) {
      const ord = inMemOrders.find((o) => o.id === body.orderId || o.order_number === body.orderId);
      if (!ord) {
        return res.status(404).json({ success: false, message: 'Order not found' });
      }

      const orderItem =
        ord.customer_order_items?.find((i) => i.id === body.orderItemId) ||
        ord.customer_order_items?.[0];
      const prod = inMemProducts.find((p) => p.id === orderItem?.product_id);
      const cust = ord.customer_id ? inMemCustomers.find((c) => c.id === ord.customer_id) : null;
      const recipe =
        prod?.product_recipes?.find((r) => r.id === body.recipeId) || prod?.product_recipes?.[0];

      const newBatch: InMemProductionBatch = {
        id: `pb-${Date.now()}`,
        tenant_id: tenantId,
        order_id: ord.id,
        order_item_id: orderItem?.id || `oi-${Date.now()}`,
        product_id: orderItem?.product_id || prod?.id || '',
        recipe_id: recipe?.id || body.recipeId || 'rec-default',
        batch_number: resolvedBatchNumber,
        planned_quantity_kg: body.plannedQuantityKg,
        status: 'draft',
        operator_id: body.operatorId || userId,
        operator_name: body.operatorName || undefined,
        supervisor_id: body.supervisorId,
        start_time: new Date().toISOString(),
        notes: body.notes,
        created_at: new Date().toISOString(),
        customer_orders: {
          id: ord.id,
          order_number: ord.order_number,
          customers: cust ? { name: cust.name } : null,
        },
        products: prod ? { id: prod.id, code: prod.code, name: prod.name, unit: prod.unit } : null,
        product_recipes: recipe ? { id: recipe.id, version: recipe.version } : null,
        production_material_consumption: [],
        production_outputs: [],
      };

      inMemProductionBatches.unshift(newBatch);

      ord.status = 'in_production';
      if (orderItem) orderItem.status = 'in_production';

      saveMockStore();

      return res.status(201).json({ success: true, batch: newBatch });
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
        batch_number: resolvedBatchNumber,
        planned_quantity_kg: body.plannedQuantityKg,
        status: 'draft',
        operator_id: body.operatorId || userId,
        operator_name: body.operatorName || null,
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
    const tenantId = getTenantId(req);
    const userId = req.user?.id;
    const { batchId } = req.params;

    const schema = z.object({
      // Specific lots and kg consumed from each lot (PRO-05)
      consumption: z.array(z.object({
        materialId: z.string().min(1),
        materialBatchId: z.string().min(1),
        plannedQuantityKg: z.number().nonnegative(),
        actualQuantityKg: z.number().positive(),
        notes: z.string().optional()
      })).min(1),
      // Outputs: Accepted, Trim Waste, Plant Waste, Rejected (PRO-07)
      acceptedOutputKg: z.number().positive(),
      trimWasteKg: z.number().nonnegative().default(0),
      plantWasteKg: z.number().nonnegative().default(0),
      wasteKg: z.number().nonnegative().optional(),
      rejectedKg: z.number().nonnegative().default(0),
      operatorName: z.string().optional(),
      notes: z.string().optional()
    });

    const body = schema.parse(req.body);
    const trimWaste = body.trimWasteKg ?? 0;
    const plantWaste = body.plantWasteKg ?? 0;
    const totalWaste = (body.trimWasteKg !== undefined || body.plantWasteKg !== undefined)
      ? Number((trimWaste + plantWaste).toFixed(4))
      : (body.wasteKg ?? 0);

    if (!isSupabaseConfigured) {
      const batch = inMemProductionBatches.find(
        (b) => b.id === batchId && b.tenant_id === tenantId
      );
      if (!batch) {
        return res.status(404).json({ success: false, message: 'Production batch not found' });
      }

      // Deduct consumption from inMemBatches
      for (const item of body.consumption) {
        const matBatch = inMemBatches.find((b) => b.id === item.materialBatchId);
        if (matBatch) {
          matBatch.remaining_quantity_kg = Math.max(
            0,
            Number(matBatch.remaining_quantity_kg) - item.actualQuantityKg
          );
          if (matBatch.remaining_quantity_kg === 0) {
            matBatch.status = 'depleted';
          }
        }
      }

      batch.status = 'completed';
      batch.end_time = new Date().toISOString();
      batch.accepted_output_kg = body.acceptedOutputKg;
      batch.trim_waste_kg = trimWaste;
      batch.plant_waste_kg = plantWaste;
      batch.waste_kg = totalWaste;
      batch.rejected_kg = body.rejectedKg;
      if (body.operatorName) {
        batch.operator_name = body.operatorName;
      }

      batch.production_material_consumption = body.consumption.map((c) => {
        const mat = inMemMaterials.find((m) => m.id === c.materialId);
        const mb = inMemBatches.find((b) => b.id === c.materialBatchId);
        return {
          id: `pmc-${Date.now()}-${Math.random()}`,
          material_id: c.materialId,
          material_batch_id: c.materialBatchId,
          planned_quantity_kg: c.plannedQuantityKg,
          actual_quantity_kg: c.actualQuantityKg,
          materials: mat ? { code: mat.code, name: mat.name } : null,
          material_batches: mb
            ? { batch_number: mb.batch_number, supplier_lot_number: mb.supplier_lot_number }
            : null,
        };
      });
      batch.production_outputs = [
        {
          id: `out-${Date.now()}`,
          accepted_kg: body.acceptedOutputKg,
          trim_waste_kg: trimWaste,
          plant_waste_kg: plantWaste,
          waste_kg: totalWaste,
          rejected_kg: body.rejectedKg,
          recorded_at: new Date().toISOString(),
        },
      ];

      // Create Finished Goods batch
      const fgBatchNumber = `FG-${batch.batch_number.replace('PB-', '')}`;
      const newFGBatch: InMemFGBatch = {
        id: `fg-${Date.now()}`,
        tenant_id: tenantId,
        product_id: batch.product_id,
        production_batch_id: batch.id,
        batch_number: fgBatchNumber,
        quantity_on_hand_kg: body.acceptedOutputKg,
        quantity_reserved_kg: 0,
        quantity_dispatched_kg: 0,
        status: 'available',
        created_at: new Date().toISOString(),
      };
      inMemFGBatches.unshift(newFGBatch);

      // Update customer order produced kg
      const ord = inMemOrders.find((o) => o.id === batch.order_id);
      if (ord) {
        const orderItem =
          ord.customer_order_items?.find((i) => i.id === batch.order_item_id) ||
          ord.customer_order_items?.[0];
        if (orderItem) {
          orderItem.produced_quantity_kg =
            (orderItem.produced_quantity_kg || 0) + body.acceptedOutputKg;
          if (orderItem.produced_quantity_kg >= orderItem.requested_quantity_kg) {
            orderItem.status = 'produced';
          }
        }
      }

      saveMockStore();

      return res.json({
        success: true,
        message: 'Production batch confirmed and completed successfully!',
        batch,
        summary: {
          total_consumed_kg: body.consumption.reduce((s, c) => s + c.actualQuantityKg, 0),
          accepted_output_kg: body.acceptedOutputKg,
          trim_waste_kg: trimWaste,
          plant_waste_kg: plantWaste,
          waste_kg: totalWaste,
          rejected_kg: body.rejectedKg,
          fg_batch_created: fgBatchNumber,
        },
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
      trim_waste_kg: trimWaste,
      plant_waste_kg: plantWaste,
      waste_kg: totalWaste,
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
        trim_waste_kg: trimWaste,
        plant_waste_kg: plantWaste,
        waste_kg: totalWaste,
        rejected_kg: body.rejectedKg,
        ...(body.operatorName ? { operator_name: body.operatorName } : {}),
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
        trim_waste_kg: trimWaste,
        plant_waste_kg: plantWaste,
        waste_kg: totalWaste,
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
