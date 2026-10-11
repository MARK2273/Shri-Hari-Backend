import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { z } from 'zod';

// List materials with total aggregated stock across active batches
export const getMaterials = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;

    if (!isSupabaseConfigured) {
      return res.json({ success: true, materials: [] });
    }

    const { data: materials, error: matError } = await supabase
      .from('materials')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('code', { ascending: true });

    if (matError) throw matError;

    // Fetch batches to aggregate total remaining stock per material
    const { data: batches, error: batchError } = await supabase
      .from('material_batches')
      .select('material_id, remaining_quantity_kg, status')
      .eq('tenant_id', tenantId)
      .eq('status', 'available');

    if (batchError) throw batchError;

    const stockMap: Record<string, number> = {};
    (batches || []).forEach((b: any) => {
      stockMap[b.material_id] = (stockMap[b.material_id] || 0) + Number(b.remaining_quantity_kg);
    });

    const enriched = materials.map((m: any) => {
      const totalStock = stockMap[m.id] || 0;
      return {
        ...m,
        total_stock_kg: totalStock,
        is_low_stock: totalStock < Number(m.min_stock_level_kg)
      };
    });

    return res.json({ success: true, materials: enriched });
  } catch (error: any) {
    console.error('[MATERIALS] Error fetching materials:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Create new material (INV-01, INV-02)
export const createMaterial = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    const schema = z.object({
      code: z.string().min(2),
      name: z.string().min(2),
      description: z.string().optional(),
      minStockLevelKg: z.number().min(0).default(100),
      standardUnit: z.string().default('kg')
    });

    const body = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      return res.status(201).json({
        success: true,
        material: { id: `mat-${Date.now()}`, ...body, min_stock_level_kg: body.minStockLevelKg, standard_unit: body.standardUnit, is_active: true }
      });
    }

    const { data, error } = await supabase
      .from('materials')
      .insert({
        tenant_id: tenantId,
        code: body.code.toUpperCase(),
        name: body.name,
        description: body.description,
        min_stock_level_kg: body.minStockLevelKg,
        standard_unit: body.standardUnit
      })
      .select('*')
      .single();

    if (error) throw error;
    return res.status(201).json({ success: true, material: data });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// List material batches with filters and FIFO sorting (INV-04, INV-06)
export const getMaterialBatches = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    const { materialId, status } = req.query;

    if (!isSupabaseConfigured) {
      return res.json({ success: true, batches: [] });
    }

    let query = supabase
      .from('material_batches')
      .select(`
        *,
        materials (id, code, name, standard_unit),
        suppliers (id, code, name)
      `)
      .eq('tenant_id', tenantId)
      .order('receipt_date', { ascending: true }); // FIFO by default

    if (materialId) query = query.eq('material_id', materialId);
    if (status) query = query.eq('status', status);

    const { data: batches, error } = await query;
    if (error) throw error;

    return res.json({ success: true, batches });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Receive new raw material lot / batch (INV-03, INV-04, INV-07)
export const receiveMaterialBatch = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    const userId = req.user?.id;

    const schema = z.object({
      materialId: z.string().uuid(),
      supplierId: z.string().uuid().optional().nullable(),
      batchNumber: z.string().min(3),
      supplierLotNumber: z.string().optional().nullable(),
      receiptDate: z.string().optional(),
      receivedQuantityKg: z.number().positive(),
      costPerKg: z.number().nonnegative().optional().default(0),
      notes: z.string().optional()
    });

    const body = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      return res.status(201).json({
        success: true,
        batch: {
          id: `mb-${Date.now()}`,
          batch_number: body.batchNumber,
          material_id: body.materialId,
          received_quantity_kg: body.receivedQuantityKg,
          remaining_quantity_kg: body.receivedQuantityKg,
          status: 'available'
        }
      });
    }

    // 1. Create the material batch
    const { data: batch, error: batchError } = await supabase
      .from('material_batches')
      .insert({
        tenant_id: tenantId,
        material_id: body.materialId,
        supplier_id: body.supplierId,
        batch_number: body.batchNumber,
        supplier_lot_number: body.supplierLotNumber,
        receipt_date: body.receiptDate || new Date().toISOString().split('T')[0],
        received_quantity_kg: body.receivedQuantityKg,
        remaining_quantity_kg: body.receivedQuantityKg,
        cost_per_kg: body.costPerKg,
        status: 'available',
        notes: body.notes,
        created_by: userId
      })
      .select('*')
      .single();

    if (batchError) throw batchError;

    // 2. Append to inventory ledger (INV-07)
    await supabase.from('inventory_transactions').insert({
      tenant_id: tenantId,
      transaction_type: 'receipt',
      item_type: 'raw_material',
      material_id: body.materialId,
      material_batch_id: batch.id,
      quantity_kg: body.receivedQuantityKg,
      reference_type: 'supplier_receipt',
      reference_id: batch.id,
      reason: `Received batch ${body.batchNumber}`,
      created_by: userId
    });

    // 3. Log audit event
    await supabase.from('audit_logs').insert({
      tenant_id: tenantId,
      user_id: userId,
      action: 'RECEIVE_MATERIAL_BATCH',
      entity_name: 'material_batches',
      entity_id: batch.id,
      new_values: batch
    });

    return res.status(201).json({ success: true, batch });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Adjust stock / corrections (INV-11)
export const adjustBatchStock = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    const userId = req.user?.id;
    const { batchId } = req.params;

    const schema = z.object({
      adjustmentQuantityKg: z.number(), // positive or negative
      reason: z.string().min(5)
    });

    const { adjustmentQuantityKg, reason } = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      return res.json({ success: true, message: 'Stock adjusted (mock mode)' });
    }

    const { data: batch, error: fetchErr } = await supabase
      .from('material_batches')
      .select('*')
      .eq('id', batchId)
      .eq('tenant_id', tenantId)
      .single();

    if (fetchErr || !batch) {
      return res.status(404).json({ success: false, message: 'Batch not found' });
    }

    const newRemaining = Number(batch.remaining_quantity_kg) + adjustmentQuantityKg;
    if (newRemaining < 0) {
      return res.status(400).json({ success: false, message: 'Adjustment would result in negative stock. Action rejected.' });
    }

    const newStatus = newRemaining === 0 ? 'depleted' : 'available';

    const { data: updatedBatch, error: updateErr } = await supabase
      .from('material_batches')
      .update({
        remaining_quantity_kg: newRemaining,
        status: newStatus,
        updated_at: new Date().toISOString()
      })
      .eq('id', batchId)
      .select('*')
      .single();

    if (updateErr) throw updateErr;

    // Ledger entry
    await supabase.from('inventory_transactions').insert({
      tenant_id: tenantId,
      transaction_type: 'adjustment',
      item_type: 'raw_material',
      material_id: batch.material_id,
      material_batch_id: batch.id,
      quantity_kg: adjustmentQuantityKg,
      reference_type: 'adjustment',
      reference_id: batch.id,
      reason,
      created_by: userId
    });

    // Audit log
    await supabase.from('audit_logs').insert({
      tenant_id: tenantId,
      user_id: userId,
      action: 'ADJUST_BATCH_STOCK',
      entity_name: 'material_batches',
      entity_id: batch.id,
      old_values: { remaining_quantity_kg: batch.remaining_quantity_kg },
      new_values: { remaining_quantity_kg: newRemaining, reason }
    });

    return res.json({ success: true, batch: updatedBatch });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
