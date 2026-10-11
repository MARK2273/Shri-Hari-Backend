import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { z } from 'zod';
import crypto from 'crypto';

interface InMemMaterial {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  description?: string;
  min_stock_level_kg: number;
  standard_unit: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface InMemBatch {
  id: string;
  tenant_id: string;
  material_id: string;
  supplier_id?: string | null;
  batch_number: string;
  supplier_lot_number?: string | null;
  receipt_date: string;
  received_quantity_kg: number;
  remaining_quantity_kg: number;
  cost_per_kg: number;
  status: string;
  notes?: string;
  created_by?: string;
  created_at: string;
}

// In-memory tenant stores when running without active Supabase credentials
export let inMemMaterials: InMemMaterial[] = [];
export let inMemBatches: InMemBatch[] = [];

const getTenantId = (req: Request): string => (req.tenantId || process.env.DEFAULT_TENANT_SLUG || 'shri-hari-pack') as string;

// List materials with total aggregated stock across active batches
export const getMaterials = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    if (!isSupabaseConfigured) {
      const tenantMaterials = inMemMaterials.filter((m) => m.tenant_id === tenantId);
      const stockMap: Record<string, number> = {};
      inMemBatches
        .filter((b) => b.tenant_id === tenantId && b.status === 'available')
        .forEach((b) => {
          stockMap[b.material_id] = (stockMap[b.material_id] || 0) + Number(b.remaining_quantity_kg);
        });

      const enriched = tenantMaterials.map((m) => {
        const totalStock = stockMap[m.id] || 0;
        return {
          ...m,
          total_stock_kg: totalStock,
          is_low_stock: totalStock < Number(m.min_stock_level_kg),
        };
      });

      return res.json({ success: true, materials: enriched });
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

    const enriched = (materials || []).map((m: any) => {
      const totalStock = stockMap[m.id] || 0;
      return {
        ...m,
        total_stock_kg: totalStock,
        is_low_stock: totalStock < Number(m.min_stock_level_kg),
      };
    });

    return res.json({ success: true, materials: enriched });
  } catch (error: any) {
    console.error('[MATERIALS] Error fetching materials:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Create new plastic material type (INV-01, INV-02)
export const createMaterial = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const schema = z.object({
      code: z.string().optional(),
      name: z.string().min(2),
      description: z.string().optional(),
      minStockLevelKg: z.number().min(0).default(100),
      standardUnit: z.string().default('kg'),
    });

    const body = schema.parse(req.body);
    const codeUpper = body.code?.trim().toUpperCase() || `MAT-${Math.floor(Math.random() * 9000 + 1000)}`;

    if (!isSupabaseConfigured) {
      // Check code uniqueness
      const exists = inMemMaterials.find(
        (m) => m.tenant_id === tenantId && m.code.toUpperCase() === codeUpper
      );
      if (exists) {
        return res.status(400).json({ success: false, message: `Material with code '${codeUpper}' already exists.` });
      }

      const newMaterial: InMemMaterial = {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        code: codeUpper,
        name: body.name.trim(),
        description: body.description?.trim() || '',
        min_stock_level_kg: body.minStockLevelKg,
        standard_unit: body.standardUnit || 'kg',
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      inMemMaterials.push(newMaterial);
      return res.status(201).json({ success: true, material: newMaterial });
    }

    const { data, error } = await supabase
      .from('materials')
      .insert({
        tenant_id: tenantId,
        code: codeUpper,
        name: body.name.trim(),
        description: body.description,
        min_stock_level_kg: body.minStockLevelKg,
        standard_unit: body.standardUnit,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ success: false, message: `Material code '${codeUpper}' already exists in this factory.` });
      }
      throw error;
    }
    return res.status(201).json({ success: true, material: data });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Update existing material type
export const updateMaterial = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;

    const schema = z.object({
      name: z.string().min(2).optional(),
      description: z.string().optional(),
      minStockLevelKg: z.number().min(0).optional(),
      isActive: z.boolean().optional(),
    });

    const body = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      const index = inMemMaterials.findIndex((m) => m.tenant_id === tenantId && m.id === id);
      if (index === -1) {
        return res.status(404).json({ success: false, message: 'Material not found.' });
      }

      inMemMaterials[index] = {
        ...inMemMaterials[index],
        ...(body.name ? { name: body.name.trim() } : {}),
        ...(body.description !== undefined ? { description: body.description.trim() } : {}),
        ...(body.minStockLevelKg !== undefined ? { min_stock_level_kg: body.minStockLevelKg } : {}),
        ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
        updated_at: new Date().toISOString(),
      };

      return res.json({ success: true, material: inMemMaterials[index] });
    }

    const updates: any = { updated_at: new Date().toISOString() };
    if (body.name) updates.name = body.name.trim();
    if (body.description !== undefined) updates.description = body.description;
    if (body.minStockLevelKg !== undefined) updates.min_stock_level_kg = body.minStockLevelKg;
    if (body.isActive !== undefined) updates.is_active = body.isActive;

    const { data, error } = await supabase
      .from('materials')
      .update(updates)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ success: true, material: data });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Delete material type (checks for linked batches first)
export const deleteMaterial = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;

    if (!isSupabaseConfigured) {
      // Check if batches are linked
      const hasBatches = inMemBatches.some((b) => b.tenant_id === tenantId && b.material_id === id);
      if (hasBatches) {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete plastic material because received inventory lots are linked to it. Mark it as inactive instead.',
        });
      }

      const initialCount = inMemMaterials.length;
      inMemMaterials = inMemMaterials.filter((m) => !(m.tenant_id === tenantId && m.id === id));
      if (inMemMaterials.length === initialCount) {
        return res.status(404).json({ success: false, message: 'Material not found.' });
      }

      return res.json({ success: true, message: 'Material deleted successfully.' });
    }

    // Supabase check
    const { count, error: countErr } = await supabase
      .from('material_batches')
      .select('*', { count: 'exact', head: true })
      .eq('material_id', id)
      .eq('tenant_id', tenantId);

    if (countErr) throw countErr;
    if (count && count > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete plastic material because received inventory lots are linked to it. Mark it as inactive instead.',
      });
    }

    const { error: delErr } = await supabase
      .from('materials')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (delErr) throw delErr;
    return res.json({ success: true, message: 'Material deleted successfully.' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Seed standard industry plastic polymers for packaging
export const seedDefaultMaterials = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    const defaults = [
      {
        code: 'HDPE-FLM',
        name: 'HDPE High-Density Film Grade',
        description: 'High tensile strength polymer for milk pouches, carry bags, and liner films (Reliance Relene / IOCL)',
        min_stock_level_kg: 500,
        standard_unit: 'kg',
      },
      {
        code: 'LDPE-GEN',
        name: 'LDPE Low-Density Extrusion Grade',
        description: 'Flexible clear resin for shrink packaging, bubble film, and heavy-duty general packaging',
        min_stock_level_kg: 500,
        standard_unit: 'kg',
      },
      {
        code: 'PP-RAF',
        name: 'PP Polypropylene Raffia & Woven Grade',
        description: 'Rigid high-clarity polymer for woven sacks, tape, and BOPP barrier films',
        min_stock_level_kg: 300,
        standard_unit: 'kg',
      },
      {
        code: 'LLDPE-STR',
        name: 'LLDPE Linear Low-Density Stretch Grade',
        description: 'High puncture-resistance polymer for industrial pallet stretch wrap and co-extruded films',
        min_stock_level_kg: 400,
        standard_unit: 'kg',
      },
      {
        code: 'MB-WHT',
        name: 'White Masterbatch (70% TiO2 Concentrate)',
        description: 'High opacity titanium dioxide white masterbatch for dairy film opacity and UV resistance',
        min_stock_level_kg: 100,
        standard_unit: 'kg',
      },
    ];

    if (!isSupabaseConfigured) {
      const added: InMemMaterial[] = [];
      for (const item of defaults) {
        const exists = inMemMaterials.find(
          (m) => m.tenant_id === tenantId && m.code.toUpperCase() === item.code
        );
        if (!exists) {
          const mat: InMemMaterial = {
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            ...item,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          inMemMaterials.push(mat);
          added.push(mat);
        }
      }
      return res.json({ success: true, message: `Configured ${added.length} packaging polymer types.`, added });
    }

    const { data: existing } = await supabase
      .from('materials')
      .select('code')
      .eq('tenant_id', tenantId);

    const existingCodes = new Set((existing || []).map((e: any) => e.code));
    const toInsert = defaults
      .filter((d) => !existingCodes.has(d.code))
      .map((d) => ({
        tenant_id: tenantId,
        ...d,
      }));

    if (toInsert.length > 0) {
      const { data, error } = await supabase.from('materials').insert(toInsert).select('*');
      if (error) throw error;
      return res.json({ success: true, message: `Configured ${toInsert.length} packaging polymer types.`, added: data });
    }

    return res.json({ success: true, message: 'All default packaging polymers already exist in this factory.', added: [] });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// List material batches with filters and FIFO sorting (INV-04, INV-06)
export const getMaterialBatches = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { materialId, status } = req.query;

    if (!isSupabaseConfigured) {
      let filtered = inMemBatches.filter((b) => b.tenant_id === tenantId);
      if (materialId) filtered = filtered.filter((b) => b.material_id === materialId);
      if (status) filtered = filtered.filter((b) => b.status === status);

      // Sort by receipt_date ascending (FIFO)
      filtered.sort((a, b) => new Date(a.receipt_date).getTime() - new Date(b.receipt_date).getTime());

      const enrichedBatches = filtered.map((b) => {
        const mat = inMemMaterials.find((m) => m.id === b.material_id);
        return {
          ...b,
          materials: mat ? { id: mat.id, code: mat.code, name: mat.name, standard_unit: mat.standard_unit } : null,
          suppliers: null,
        };
      });

      return res.json({ success: true, batches: enrichedBatches });
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
    const tenantId = getTenantId(req);
    const userId = req.user?.id;

    const schema = z.object({
      materialId: z.string().min(1),
      supplierId: z.string().optional().nullable(),
      batchNumber: z.string().optional(),
      supplierLotNumber: z.string().optional().nullable(),
      receiptDate: z.string().optional(),
      receivedQuantityKg: z.number().positive(),
      costPerKg: z.number().nonnegative().optional().default(0),
      notes: z.string().optional(),
    });

    const body = schema.parse(req.body);
    const resolvedBatchNumber = body.batchNumber?.trim() || `MB-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 900 + 100)}`;

    if (!isSupabaseConfigured) {
      const mat = inMemMaterials.find((m) => m.tenant_id === tenantId && m.id === body.materialId);
      if (!mat) {
        return res.status(404).json({ success: false, message: 'Selected plastic material not found.' });
      }

      const newBatch: InMemBatch = {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        material_id: body.materialId,
        supplier_id: body.supplierId || null,
        batch_number: resolvedBatchNumber,
        supplier_lot_number: body.supplierLotNumber?.trim() || null,
        receipt_date: body.receiptDate || new Date().toISOString().split('T')[0],
        received_quantity_kg: body.receivedQuantityKg,
        remaining_quantity_kg: body.receivedQuantityKg,
        cost_per_kg: body.costPerKg || 0,
        status: 'available',
        notes: body.notes?.trim() || '',
        created_by: userId,
        created_at: new Date().toISOString(),
      };

      inMemBatches.push(newBatch);
      return res.status(201).json({ success: true, batch: newBatch });
    }

    // 1. Create the material batch in Supabase
    const { data: batch, error: batchError } = await supabase
      .from('material_batches')
      .insert({
        tenant_id: tenantId,
        material_id: body.materialId,
        supplier_id: body.supplierId,
        batch_number: resolvedBatchNumber,
        supplier_lot_number: body.supplierLotNumber,
        receipt_date: body.receiptDate || new Date().toISOString().split('T')[0],
        received_quantity_kg: body.receivedQuantityKg,
        remaining_quantity_kg: body.receivedQuantityKg,
        cost_per_kg: body.costPerKg,
        status: 'available',
        notes: body.notes,
        created_by: userId,
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
      created_by: userId,
    });

    // 3. Log audit event
    await supabase.from('audit_logs').insert({
      tenant_id: tenantId,
      user_id: userId,
      action: 'RECEIVE_MATERIAL_BATCH',
      entity_name: 'material_batches',
      entity_id: batch.id,
      new_values: batch,
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
    const tenantId = getTenantId(req);
    const userId = req.user?.id;
    const { batchId } = req.params;

    const schema = z.object({
      adjustmentQuantityKg: z.number(), // positive or negative
      reason: z.string().min(5),
    });

    const { adjustmentQuantityKg, reason } = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      const batch = inMemBatches.find((b) => b.tenant_id === tenantId && b.id === batchId);
      if (!batch) {
        return res.status(404).json({ success: false, message: 'Batch not found.' });
      }

      const newRemaining = Number(batch.remaining_quantity_kg) + adjustmentQuantityKg;
      if (newRemaining < 0) {
        return res.status(400).json({ success: false, message: 'Adjustment would result in negative stock. Action rejected.' });
      }

      batch.remaining_quantity_kg = newRemaining;
      batch.status = newRemaining === 0 ? 'depleted' : 'available';

      return res.json({ success: true, batch });
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
        updated_at: new Date().toISOString(),
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
      created_by: userId,
    });

    // Audit log
    await supabase.from('audit_logs').insert({
      tenant_id: tenantId,
      user_id: userId,
      action: 'ADJUST_BATCH_STOCK',
      entity_name: 'material_batches',
      entity_id: batch.id,
      old_values: { remaining_quantity_kg: batch.remaining_quantity_kg },
      new_values: { remaining_quantity_kg: newRemaining, reason },
    });

    return res.json({ success: true, batch: updatedBatch });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
