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
  supplier_name?: string | null;
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

interface InMemSupplier {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  contact_person?: string;
  phone?: string;
  email?: string;
  address?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

import { mockStore, saveMockStore } from '../utils/mockStore';

// In-memory tenant stores when running without active Supabase credentials
export let inMemMaterials: InMemMaterial[] = mockStore.materials;
export let inMemBatches: InMemBatch[] = mockStore.batches;
export let inMemSuppliers: InMemSupplier[] = mockStore.suppliers || [];

const getTenantId = (req: Request): string => (req.tenantId || process.env.DEFAULT_TENANT_SLUG || 'shri-hari-pack') as string;

// List materials with total aggregated stock across active batches
export const getMaterials = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    if (!isSupabaseConfigured) {
      const tenantMaterials = inMemMaterials.filter((m) => m.tenant_id === tenantId);
      const stockMap: Record<string, number> = {};
      const costMap: Record<
        string,
        {
          remainingVal: number;
          remainingQty: number;
          receivedVal: number;
          receivedQty: number;
          latestCost: number;
          latestDate: string;
        }
      > = {};

      inMemBatches
        .filter((b) => b.tenant_id === tenantId)
        .forEach((b) => {
          const remQty = Number(b.remaining_quantity_kg) || 0;
          const recQty = Number(b.received_quantity_kg) || 0;
          const cost = Number(b.cost_per_kg) || 0;
          const dateStr = b.receipt_date || b.created_at || '';

          if (b.status === 'available') {
            stockMap[b.material_id] = (stockMap[b.material_id] || 0) + remQty;
          }

          if (cost > 0) {
            if (!costMap[b.material_id]) {
              costMap[b.material_id] = {
                remainingVal: 0,
                remainingQty: 0,
                receivedVal: 0,
                receivedQty: 0,
                latestCost: cost,
                latestDate: dateStr,
              };
            }
            if (b.status === 'available' && remQty > 0) {
              costMap[b.material_id].remainingVal += cost * remQty;
              costMap[b.material_id].remainingQty += remQty;
            }
            costMap[b.material_id].receivedVal += cost * recQty;
            costMap[b.material_id].receivedQty += recQty;
            if (dateStr >= costMap[b.material_id].latestDate) {
              costMap[b.material_id].latestCost = cost;
              costMap[b.material_id].latestDate = dateStr;
            }
          }
        });

      const enriched = tenantMaterials.map((m) => {
        const totalStock = stockMap[m.id] || 0;
        const cInfo = costMap[m.id];
        // Weighted average cost based on remaining stock quantities
        const weightedAvgCost =
          cInfo && cInfo.remainingQty > 0
            ? cInfo.remainingVal / cInfo.remainingQty
            : cInfo && cInfo.receivedQty > 0
            ? cInfo.receivedVal / cInfo.receivedQty
            : cInfo?.latestCost || 0;
        const totalStockVal = cInfo?.remainingVal || totalStock * weightedAvgCost;

        return {
          ...m,
          total_stock_kg: totalStock,
          cost_per_kg: Number(weightedAvgCost.toFixed(2)),
          weighted_avg_cost_per_kg: Number(weightedAvgCost.toFixed(2)),
          avg_cost_per_kg: Number(weightedAvgCost.toFixed(2)),
          latest_cost_per_kg: Number((cInfo?.latestCost || 0).toFixed(2)),
          total_stock_value: Number(totalStockVal.toFixed(2)),
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

    // Fetch batches to aggregate total remaining stock and weighted cost per material
    const { data: batches, error: batchError } = await supabase
      .from('material_batches')
      .select('material_id, remaining_quantity_kg, received_quantity_kg, cost_per_kg, receipt_date, created_at, status')
      .eq('tenant_id', tenantId);

    if (batchError) throw batchError;

    const stockMap: Record<string, number> = {};
    const costMap: Record<
      string,
      {
        remainingVal: number;
        remainingQty: number;
        receivedVal: number;
        receivedQty: number;
        latestCost: number;
        latestDate: string;
      }
    > = {};

    (batches || []).forEach((b: any) => {
      const remQty = Number(b.remaining_quantity_kg) || 0;
      const recQty = Number(b.received_quantity_kg) || 0;
      const cost = Number(b.cost_per_kg) || 0;
      const dateStr = b.receipt_date || b.created_at || '';

      if (b.status === 'available') {
        stockMap[b.material_id] = (stockMap[b.material_id] || 0) + remQty;
      }

      if (cost > 0) {
        if (!costMap[b.material_id]) {
          costMap[b.material_id] = {
            remainingVal: 0,
            remainingQty: 0,
            receivedVal: 0,
            receivedQty: 0,
            latestCost: cost,
            latestDate: dateStr,
          };
        }
        if (b.status === 'available' && remQty > 0) {
          costMap[b.material_id].remainingVal += cost * remQty;
          costMap[b.material_id].remainingQty += remQty;
        }
        costMap[b.material_id].receivedVal += cost * recQty;
        costMap[b.material_id].receivedQty += recQty;
        if (dateStr >= costMap[b.material_id].latestDate) {
          costMap[b.material_id].latestCost = cost;
          costMap[b.material_id].latestDate = dateStr;
        }
      }
    });

    const enriched = (materials || []).map((m: any) => {
      const totalStock = stockMap[m.id] || 0;
      const cInfo = costMap[m.id];
      // Weighted average cost based on remaining stock quantities
      const weightedAvgCost =
        cInfo && cInfo.remainingQty > 0
          ? cInfo.remainingVal / cInfo.remainingQty
          : cInfo && cInfo.receivedQty > 0
          ? cInfo.receivedVal / cInfo.receivedQty
          : cInfo?.latestCost || 0;
      const totalStockVal = cInfo?.remainingVal || totalStock * weightedAvgCost;

      return {
        ...m,
        total_stock_kg: totalStock,
        cost_per_kg: Number(weightedAvgCost.toFixed(2)),
        weighted_avg_cost_per_kg: Number(weightedAvgCost.toFixed(2)),
        avg_cost_per_kg: Number(weightedAvgCost.toFixed(2)),
        latest_cost_per_kg: Number((cInfo?.latestCost || 0).toFixed(2)),
        total_stock_value: Number(totalStockVal.toFixed(2)),
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

// List raw material suppliers / vendors
export const getSuppliers = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    if (!isSupabaseConfigured) {
      const list = inMemSuppliers.filter((s) => s.tenant_id === tenantId);
      return res.json({ success: true, suppliers: list });
    }

    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('name');

    if (error) throw error;
    return res.json({ success: true, suppliers: data || [] });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Create new supplier / vendor master entry
export const createSupplier = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const schema = z.object({
      name: z.string().min(2, 'Vendor/Supplier name is required'),
      code: z.string().optional(),
      contactPerson: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      address: z.string().optional(),
    });

    const body = schema.parse(req.body);
    const resolvedCode = body.code?.trim().toUpperCase() || `SUP-${Math.floor(Math.random() * 9000 + 1000)}`;

    if (!isSupabaseConfigured) {
      const exists = inMemSuppliers.some(
        (s) => s.tenant_id === tenantId && s.name.toLowerCase() === body.name.trim().toLowerCase()
      );
      if (exists) {
        return res.status(400).json({ success: false, message: `Supplier '${body.name.trim()}' already exists.` });
      }

      const newSupplier: InMemSupplier = {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        code: resolvedCode,
        name: body.name.trim(),
        contact_person: body.contactPerson?.trim() || '',
        phone: body.phone?.trim() || '',
        email: body.email?.trim() || '',
        address: body.address?.trim() || '',
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      inMemSuppliers.push(newSupplier);
      mockStore.suppliers = inMemSuppliers;
      saveMockStore();

      return res.status(201).json({ success: true, supplier: newSupplier });
    }

    const { data, error } = await supabase
      .from('suppliers')
      .insert({
        tenant_id: tenantId,
        code: resolvedCode,
        name: body.name.trim(),
        contact_person: body.contactPerson?.trim() || null,
        phone: body.phone?.trim() || null,
        email: body.email?.trim() || null,
        address: body.address?.trim() || null,
        is_active: true,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ success: false, message: `Supplier code '${resolvedCode}' already exists.` });
      }
      throw error;
    }

    return res.status(201).json({ success: true, supplier: data });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Update supplier / vendor master entry
export const updateSupplier = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;

    const schema = z.object({
      name: z.string().min(2).optional(),
      contactPerson: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      address: z.string().optional(),
      isActive: z.boolean().optional(),
    });

    const body = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      const idx = inMemSuppliers.findIndex((s) => s.tenant_id === tenantId && s.id === id);
      if (idx === -1) {
        return res.status(404).json({ success: false, message: 'Supplier not found.' });
      }

      inMemSuppliers[idx] = {
        ...inMemSuppliers[idx],
        name: body.name !== undefined ? body.name.trim() : inMemSuppliers[idx].name,
        contact_person: body.contactPerson !== undefined ? body.contactPerson.trim() : inMemSuppliers[idx].contact_person,
        phone: body.phone !== undefined ? body.phone.trim() : inMemSuppliers[idx].phone,
        email: body.email !== undefined ? body.email.trim() : inMemSuppliers[idx].email,
        address: body.address !== undefined ? body.address.trim() : inMemSuppliers[idx].address,
        is_active: body.isActive !== undefined ? body.isActive : inMemSuppliers[idx].is_active,
        updated_at: new Date().toISOString(),
      };

      mockStore.suppliers = inMemSuppliers;
      saveMockStore();

      return res.json({ success: true, supplier: inMemSuppliers[idx] });
    }

    const updatePayload: any = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) updatePayload.name = body.name.trim();
    if (body.contactPerson !== undefined) updatePayload.contact_person = body.contactPerson.trim();
    if (body.phone !== undefined) updatePayload.phone = body.phone.trim();
    if (body.email !== undefined) updatePayload.email = body.email.trim();
    if (body.address !== undefined) updatePayload.address = body.address.trim();
    if (body.isActive !== undefined) updatePayload.is_active = body.isActive;

    const { data, error } = await supabase
      .from('suppliers')
      .update(updatePayload)
      .eq('tenant_id', tenantId)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ success: true, supplier: data });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Delete supplier / vendor
export const deleteSupplier = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;

    if (!isSupabaseConfigured) {
      const idx = inMemSuppliers.findIndex((s) => s.tenant_id === tenantId && s.id === id);
      if (idx === -1) {
        return res.status(404).json({ success: false, message: 'Supplier not found.' });
      }
      inMemSuppliers.splice(idx, 1);
      mockStore.suppliers = inMemSuppliers;
      saveMockStore();
      return res.json({ success: true, message: 'Supplier deleted successfully.' });
    }

    const { error } = await supabase
      .from('suppliers')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('id', id);

    if (error) throw error;
    return res.json({ success: true, message: 'Supplier deleted successfully.' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Receive new raw material lot / batch (INV-03, INV-04, INV-07)
export const receiveMaterialBatch = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = req.user?.id;

    const singleItemSchema = z.object({
      materialId: z.string().min(1),
      supplierId: z.string().optional().nullable(),
      supplierName: z.string().optional().nullable(),
      batchNumber: z.string().optional(),
      supplierLotNumber: z.string().optional().nullable(),
      receiptDate: z.string().optional(),
      receivedQuantityKg: z.number().positive(),
      costPerKg: z.number().positive({ message: 'Cost per KG is required and must be greater than 0' }),
      notes: z.string().optional(),
    });

    const multiItemSchema = z.object({
      supplierId: z.string().optional().nullable(),
      supplierName: z.string().optional().nullable(),
      receiptDate: z.string().optional(),
      supplierInvoiceNo: z.string().optional().nullable(),
      notes: z.string().optional(),
      items: z.array(
        z.object({
          materialId: z.string().min(1, 'Please select a plastic material'),
          receivedQuantityKg: z.number().positive('Received weight must be greater than 0'),
          costPerKg: z.number().positive({ message: 'Cost per KG must be greater than 0' }),
          supplierLotNumber: z.string().optional().nullable(),
          batchNumber: z.string().optional(),
          notes: z.string().optional(),
        })
      ).min(1, 'At least one material item is required'),
    });

    // Check if request is multi-item or single item
    let itemsToProcess: Array<{
      materialId: string;
      supplierId: string | null;
      supplierName: string | null;
      batchNumber: string;
      supplierLotNumber: string | null;
      receiptDate: string;
      receivedQuantityKg: number;
      costPerKg: number;
      notes: string;
    }> = [];

    const todayDate = new Date().toISOString().split('T')[0];
    const todayCompact = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    if (req.body && Array.isArray(req.body.items)) {
      const parsedMulti = multiItemSchema.parse(req.body);
      const headerSupplierId = parsedMulti.supplierId || null;
      const headerSupplierName = parsedMulti.supplierName?.trim() || null;
      const headerReceiptDate = parsedMulti.receiptDate || todayDate;
      const headerInvoice = parsedMulti.supplierInvoiceNo?.trim() || null;
      const headerNotes = parsedMulti.notes?.trim() || '';

      itemsToProcess = parsedMulti.items.map((it, idx) => {
        const randSuffix = Math.floor(Math.random() * 900 + 100) + idx;
        const bNum = it.batchNumber?.trim() || `MB-${todayCompact}-${randSuffix}`;
        const lotNum = it.supplierLotNumber?.trim() || headerInvoice || null;
        const combinedNotes = [it.notes?.trim(), headerNotes].filter(Boolean).join(' | ');

        return {
          materialId: it.materialId,
          supplierId: headerSupplierId,
          supplierName: headerSupplierName,
          batchNumber: bNum,
          supplierLotNumber: lotNum,
          receiptDate: headerReceiptDate,
          receivedQuantityKg: it.receivedQuantityKg,
          costPerKg: it.costPerKg,
          notes: combinedNotes,
        };
      });
    } else {
      const body = singleItemSchema.parse(req.body);
      const randSuffix = Math.floor(Math.random() * 900 + 100);
      const bNum = body.batchNumber?.trim() || `MB-${todayCompact}-${randSuffix}`;

      itemsToProcess = [
        {
          materialId: body.materialId,
          supplierId: body.supplierId || null,
          supplierName: body.supplierName?.trim() || null,
          batchNumber: bNum,
          supplierLotNumber: body.supplierLotNumber?.trim() || null,
          receiptDate: body.receiptDate || todayDate,
          receivedQuantityKg: body.receivedQuantityKg,
          costPerKg: body.costPerKg,
          notes: body.notes?.trim() || '',
        },
      ];
    }

    if (!isSupabaseConfigured) {
      const createdBatches: InMemBatch[] = [];

      for (const item of itemsToProcess) {
        const mat = inMemMaterials.find((m) => m.tenant_id === tenantId && m.id === item.materialId);
        if (!mat) {
          return res.status(404).json({ success: false, message: `Plastic material ${item.materialId} not found.` });
        }

        const newBatch: InMemBatch = {
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          material_id: item.materialId,
          supplier_id: item.supplierId,
          supplier_name: item.supplierName,
          batch_number: item.batchNumber,
          supplier_lot_number: item.supplierLotNumber,
          receipt_date: item.receiptDate,
          received_quantity_kg: item.receivedQuantityKg,
          remaining_quantity_kg: item.receivedQuantityKg,
          cost_per_kg: item.costPerKg,
          status: 'available',
          notes: item.notes,
          created_by: userId,
          created_at: new Date().toISOString(),
        };

        inMemBatches.push(newBatch);
        createdBatches.push(newBatch);
      }

      mockStore.batches = inMemBatches;
      saveMockStore();

      return res.status(201).json({
        success: true,
        count: createdBatches.length,
        batches: createdBatches,
        batch: createdBatches[0],
      });
    }

    // 1. Create the material batches in Supabase
    const createdBatches: any[] = [];
    for (const item of itemsToProcess) {
      const { data: batch, error: batchError } = await supabase
        .from('material_batches')
        .insert({
          tenant_id: tenantId,
          material_id: item.materialId,
          supplier_id: item.supplierId,
          supplier_name: item.supplierName,
          batch_number: item.batchNumber,
          supplier_lot_number: item.supplierLotNumber,
          receipt_date: item.receiptDate,
          received_quantity_kg: item.receivedQuantityKg,
          remaining_quantity_kg: item.receivedQuantityKg,
          cost_per_kg: item.costPerKg,
          status: 'available',
          notes: item.notes,
          created_by: userId,
        })
        .select('*')
        .single();

      if (batchError) throw batchError;
      createdBatches.push(batch);

      // 2. Append to inventory ledger (INV-07)
      await supabase.from('inventory_transactions').insert({
        tenant_id: tenantId,
        transaction_type: 'receipt',
        item_type: 'raw_material',
        material_id: item.materialId,
        material_batch_id: batch.id,
        quantity_kg: item.receivedQuantityKg,
        reference_type: 'supplier_receipt',
        reference_id: batch.id,
        reason: `Received batch ${item.batchNumber}`,
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
    }

    return res.status(201).json({
      success: true,
      count: createdBatches.length,
      batches: createdBatches,
      batch: createdBatches[0],
    });
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
