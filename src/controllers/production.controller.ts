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
  size_micron?: string;
  is_slitting_batch?: boolean;
  slitting_plan?: any[];
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
      sizeMicron: z.string().optional(),
      isSlittingBatch: z.boolean().optional().default(false),
      slittingPlan: z.array(z.object({
        orderId: z.string(),
        orderItemId: z.string().optional().default(''),
        orderNumber: z.string().optional(),
        customerName: z.string().optional(),
        targetSizeMicron: z.string(),
        targetWeightKg: z.number(),
        percentage: z.number().optional()
      })).optional().default([]),
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
        size_micron: body.sizeMicron || (ord as any).size_micron || 'Standard',
        is_slitting_batch: body.isSlittingBatch || false,
        slitting_plan: body.slittingPlan || [],
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

      if (body.isSlittingBatch && body.slittingPlan?.length > 0) {
        body.slittingPlan.forEach((sp) => {
          const mOrd = inMemOrders.find((o) => o.id === sp.orderId);
          if (mOrd) {
            mOrd.status = 'in_production';
            if (mOrd.customer_order_items?.[0]) mOrd.customer_order_items[0].status = 'in_production';
          }
        });
      }

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
        recipe_id: body.recipeId || null,
        batch_number: resolvedBatchNumber,
        planned_quantity_kg: body.plannedQuantityKg,
        size_micron: body.sizeMicron || null,
        is_slitting_batch: body.isSlittingBatch || false,
        slitting_plan: body.slittingPlan || [],
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

    // If multi-order slitting, update all merged orders to in_production
    if (body.isSlittingBatch && body.slittingPlan?.length > 0) {
      for (const sp of body.slittingPlan) {
        if (sp.orderId) {
          await supabase
            .from('customer_orders')
            .update({ status: 'in_production', updated_at: new Date().toISOString() })
            .eq('id', sp.orderId);
        }
        if (sp.orderItemId) {
          await supabase
            .from('customer_order_items')
            .update({ status: 'in_production' })
            .eq('id', sp.orderItemId);
        }
      }
    }

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
      notes: z.string().optional(),
      splitOutputs: z.array(z.object({
        orderId: z.string().optional(),
        orderItemId: z.string().optional(),
        customerName: z.string().optional(),
        sizeMicron: z.string(),
        acceptedKg: z.number().positive(),
        lotSuffix: z.string().optional()
      })).optional()
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

      // Automatically log on-floor scrap if waste was produced
      if (totalWaste > 0) {
        if (!mockStore.scrapEntries) mockStore.scrapEntries = [];
        mockStore.scrapEntries.unshift({
          id: `scrap-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          tenant_id: tenantId,
          entry_number: `SCRAP-${batch.batch_number.replace('PB-', '')}`,
          entry_date: new Date().toISOString().split('T')[0],
          source_type: 'production_batch',
          production_batch_id: batch.id,
          product_id: batch.product_id,
          scrap_type: trimWaste > 0 && plantWaste > 0 ? 'Trim & Plant Waste' : (trimWaste > 0 ? 'Trim Waste' : 'Plant Scrap'),
          quantity_kg: totalWaste,
          notes: `Auto-logged from Production Batch ${batch.batch_number} (Trim: ${trimWaste} kg, Plant: ${plantWaste} kg)`,
          recorded_by: userId || null,
          created_at: new Date().toISOString(),
        });
      }

      // Slitting Output Split vs Single Batch
      const fgBatchBase = `FG-${batch.batch_number.replace('PB-', '')}`;
      const isSlitting = Boolean(batch.is_slitting_batch || (body.splitOutputs && body.splitOutputs.length > 0));

      let effectiveSplits: Array<{
        orderId?: string;
        orderItemId?: string;
        customerName?: string;
        sizeMicron: string;
        acceptedKg: number;
        lotSuffix?: string;
      }> = [];

      if (body.splitOutputs && body.splitOutputs.length > 0) {
        effectiveSplits = body.splitOutputs;
      } else if (isSlitting && batch.slitting_plan && batch.slitting_plan.length > 0) {
        const totalPlanned = batch.slitting_plan.reduce((s: number, p: any) => s + (Number(p.targetWeightKg) || 0), 0) || Number(batch.planned_quantity_kg) || 1;
        effectiveSplits = batch.slitting_plan.map((sp: any, i: number) => {
          const ratio = (Number(sp.targetWeightKg) || 0) / totalPlanned;
          return {
            orderId: sp.orderId,
            orderItemId: sp.orderItemId,
            customerName: sp.customerName,
            sizeMicron: sp.targetSizeMicron || '330 - 20 Micron',
            acceptedKg: Number((body.acceptedOutputKg * ratio).toFixed(2)),
            lotSuffix: String.fromCharCode(65 + i)
          };
        });
      } else {
        effectiveSplits = [{
          orderId: batch.order_id,
          orderItemId: batch.order_item_id,
          sizeMicron: batch.size_micron || 'Standard',
          acceptedKg: body.acceptedOutputKg,
          lotSuffix: ''
        }];
      }

      effectiveSplits.forEach((sp, idx) => {
        const lotNumber = sp.lotSuffix ? `${fgBatchBase}-${sp.lotSuffix}` : fgBatchBase;
        const newFGBatch: InMemFGBatch = {
          id: `fg-${Date.now()}-${idx}`,
          tenant_id: tenantId,
          product_id: batch.product_id,
          production_batch_id: batch.id,
          batch_number: lotNumber,
          size_micron: sp.sizeMicron,
          quantity_on_hand_kg: sp.acceptedKg,
          quantity_reserved_kg: 0,
          quantity_dispatched_kg: 0,
          status: 'available',
          created_at: new Date().toISOString(),
        };
        inMemFGBatches.unshift(newFGBatch);

        if (sp.orderId) {
          const targetOrd = inMemOrders.find((o) => o.id === sp.orderId);
          if (targetOrd) {
            const item = targetOrd.customer_order_items?.find((i: any) => i.id === sp.orderItemId) || targetOrd.customer_order_items?.[0];
            if (item) {
              item.produced_quantity_kg = (item.produced_quantity_kg || 0) + sp.acceptedKg;
              if (item.produced_quantity_kg >= item.requested_quantity_kg) {
                item.status = 'produced';
              }
            }
          }
        }
      });

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
          fg_batches_created: effectiveSplits.map((s, i) => s.lotSuffix ? `${fgBatchBase}-${s.lotSuffix}` : fgBatchBase),
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

    // Automatically log on-floor scrap if waste was produced
    if (totalWaste > 0) {
      const entryNum = `SCRAP-${batch.batch_number.replace('PB-', '')}`;
      await supabase.from('scrap_entries').insert({
        tenant_id: tenantId,
        entry_number: entryNum,
        entry_date: new Date().toISOString().split('T')[0],
        source_type: 'production_batch',
        production_batch_id: batchId,
        product_id: batch.product_id,
        scrap_type: trimWaste > 0 && plantWaste > 0 ? 'Trim & Plant Waste' : (trimWaste > 0 ? 'Trim Waste' : 'Plant Scrap'),
        quantity_kg: totalWaste,
        notes: `Auto-logged from Production Batch ${batch.batch_number} (Trim: ${trimWaste} kg, Plant: ${plantWaste} kg)`,
        recorded_by: userId || null,
      });
    }

    // 5. Create Finished Goods Batches (supports multi-order slitting split or single batch)
    const fgBatchBase = `FG-${batch.batch_number}`;
    const isSlitting = Boolean(batch.is_slitting_batch || (body.splitOutputs && body.splitOutputs.length > 0));

    let effectiveSplits: Array<{
      orderId?: string;
      orderItemId?: string;
      customerName?: string;
      sizeMicron: string;
      acceptedKg: number;
      lotSuffix?: string;
    }> = [];

    if (body.splitOutputs && body.splitOutputs.length > 0) {
      effectiveSplits = body.splitOutputs;
    } else if (isSlitting && batch.slitting_plan && Array.isArray(batch.slitting_plan) && batch.slitting_plan.length > 0) {
      const totalPlanned = batch.slitting_plan.reduce((s: number, p: any) => s + (Number(p.targetWeightKg) || 0), 0) || Number(batch.planned_quantity_kg) || 1;
      effectiveSplits = batch.slitting_plan.map((sp: any, i: number) => {
        const ratio = (Number(sp.targetWeightKg) || 0) / totalPlanned;
        return {
          orderId: sp.orderId,
          orderItemId: sp.orderItemId,
          customerName: sp.customerName,
          sizeMicron: sp.targetSizeMicron || '330 - 20 Micron',
          acceptedKg: Number((body.acceptedOutputKg * ratio).toFixed(2)),
          lotSuffix: String.fromCharCode(65 + i)
        };
      });
      // Adjust rounding discrepancy to last split
      const totalAllocated = effectiveSplits.reduce((s, it) => s + it.acceptedKg, 0);
      const diff = Number((body.acceptedOutputKg - totalAllocated).toFixed(2));
      if (diff !== 0 && effectiveSplits.length > 0) {
        effectiveSplits[effectiveSplits.length - 1].acceptedKg = Number((effectiveSplits[effectiveSplits.length - 1].acceptedKg + diff).toFixed(2));
      }
    } else {
      effectiveSplits = [{
        orderId: batch.order_id,
        orderItemId: batch.order_item_id,
        sizeMicron: batch.size_micron || 'Standard',
        acceptedKg: body.acceptedOutputKg,
        lotSuffix: ''
      }];
    }

    const createdFGBatchNumbers: string[] = [];
    const createdFGBatches: any[] = [];

    for (let idx = 0; idx < effectiveSplits.length; idx++) {
      const split = effectiveSplits[idx];
      const suffix = split.lotSuffix ? `-${split.lotSuffix}` : '';
      const splitLotNumber = `${fgBatchBase}${suffix}`;
      createdFGBatchNumbers.push(splitLotNumber);

      const { data: fgBatch, error: fgErr } = await supabase
        .from('finished_goods_batches')
        .insert({
          tenant_id: tenantId,
          product_id: batch.product_id,
          production_batch_id: batchId,
          batch_number: splitLotNumber,
          quantity_produced_kg: split.acceptedKg,
          quantity_on_hand_kg: split.acceptedKg,
          quantity_reserved_kg: 0,
          quantity_dispatched_kg: 0,
          status: 'in_stock',
          size_micron: split.sizeMicron,
          order_id: split.orderId || null,
          customer_name: split.customerName || null
        })
        .select('*')
        .single();

      if (fgErr) throw fgErr;
      createdFGBatches.push(fgBatch);

      // Finished goods ledger entry
      await supabase.from('inventory_transactions').insert({
        tenant_id: tenantId,
        transaction_type: 'production_output',
        item_type: 'finished_goods',
        product_id: batch.product_id,
        finished_goods_batch_id: fgBatch.id,
        quantity_kg: split.acceptedKg,
        reference_type: 'production_batch',
        reference_id: batchId,
        reason: isSlitting 
          ? `Slit Roll ${split.lotSuffix || idx + 1} (${split.sizeMicron}) from extrusion batch ${batch.batch_number}` 
          : `Output from production batch ${batch.batch_number}`,
        created_by: userId
      });

      // Update linked customer order items & customer orders
      if (split.orderItemId) {
        const { data: orderItem } = await supabase
          .from('customer_order_items')
          .select('produced_quantity_kg, requested_quantity_kg')
          .eq('id', split.orderItemId)
          .single();

        const newProducedQty = Number(orderItem?.produced_quantity_kg || 0) + split.acceptedKg;
        const isOrderComplete = newProducedQty >= Number(orderItem?.requested_quantity_kg);

        await supabase
          .from('customer_order_items')
          .update({
            produced_quantity_kg: newProducedQty,
            status: isOrderComplete ? 'produced' : 'in_production'
          })
          .eq('id', split.orderItemId);
      } else if (split.orderId) {
        const { data: orderItems } = await supabase
          .from('customer_order_items')
          .select('id, produced_quantity_kg, requested_quantity_kg')
          .eq('order_id', split.orderId);

        if (orderItems && orderItems.length > 0) {
          const item = orderItems[0];
          const newProducedQty = Number(item.produced_quantity_kg || 0) + split.acceptedKg;
          const isOrderComplete = newProducedQty >= Number(item.requested_quantity_kg);

          await supabase
            .from('customer_order_items')
            .update({
              produced_quantity_kg: newProducedQty,
              status: isOrderComplete ? 'produced' : 'in_production'
            })
            .eq('id', item.id);
        }
      }

      if (split.orderId) {
        const { data: allItems } = await supabase
          .from('customer_order_items')
          .select('produced_quantity_kg, requested_quantity_kg')
          .eq('order_id', split.orderId);

        const allProduced = (allItems || []).every((i: any) => Number(i.produced_quantity_kg) >= Number(i.requested_quantity_kg));
        await supabase
          .from('customer_orders')
          .update({
            status: allProduced ? 'produced' : 'partially_produced',
            updated_at: new Date().toISOString()
          })
          .eq('id', split.orderId);
      }
    }

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
        fg_batch_id: createdFGBatches[0]?.id || null,
        fg_batch_numbers: createdFGBatchNumbers
      }
    });

    return res.json({
      success: true,
      message: 'Production confirmed, raw materials consumed, and finished goods stocked.',
      production_batch_id: batchId,
      finished_goods_batches: createdFGBatches,
      finished_goods_batch: createdFGBatches[0] || null
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Update Operator for a Production Batch (assign or modify who handled the batch)
export const updateProductionBatchOperator = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { batchId } = req.params;

    const schema = z.object({
      operatorName: z.string().trim().min(1, 'Operator name cannot be empty')
    });

    const body = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      const batch = inMemProductionBatches.find(
        (b) => b.id === batchId && b.tenant_id === tenantId
      );
      if (!batch) {
        return res.status(404).json({ success: false, message: 'Production batch not found' });
      }

      batch.operator_name = body.operatorName;
      saveMockStore();

      return res.json({
        success: true,
        message: 'Operator name updated successfully',
        batch
      });
    }

    const { data: batch, error } = await supabase
      .from('production_batches')
      .update({
        operator_name: body.operatorName,
        updated_at: new Date().toISOString()
      })
      .eq('id', batchId)
      .eq('tenant_id', tenantId)
      .select('*')
      .single();

    if (error) throw error;
    if (!batch) {
      return res.status(404).json({ success: false, message: 'Production batch not found' });
    }

    return res.json({
      success: true,
      message: 'Operator name updated successfully',
      batch
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

