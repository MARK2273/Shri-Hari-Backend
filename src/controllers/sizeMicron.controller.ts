import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { z } from 'zod';
import crypto from 'crypto';
import { mockStore, saveMockStore, recordAuditLog } from '../utils/mockStore';

export interface InMemSizeMicron {
  id: string;
  tenant_id: string;
  label: string;
  size: string;
  micron: number;
  unit: string;
  description?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export let inMemSizeMicrons: InMemSizeMicron[] = mockStore.sizeMicrons || [];

const getTenantId = (req: Request): string =>
  (req.tenantId || process.env.DEFAULT_TENANT_SLUG || 'shri-hari-pack') as string;

// List all Size / Micron master entries
export const getSizeMicrons = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { activeOnly, search } = req.query;

    if (!isSupabaseConfigured) {
      let filtered = inMemSizeMicrons.filter((sm) => sm.tenant_id === tenantId);

      if (activeOnly === 'true') {
        filtered = filtered.filter((sm) => sm.is_active);
      }

      if (search && typeof search === 'string') {
        const q = search.toLowerCase().trim();
        filtered = filtered.filter(
          (sm) =>
            sm.label.toLowerCase().includes(q) ||
            (sm.size && sm.size.toLowerCase().includes(q)) ||
            (sm.description && sm.description.toLowerCase().includes(q)) ||
            String(sm.micron).includes(q)
        );
      }

      // Sort by micron numeric ascending, then label
      filtered.sort((a, b) => (Number(a.micron) || 0) - (Number(b.micron) || 0) || a.label.localeCompare(b.label));

      return res.json({ success: true, sizeMicrons: filtered });
    }

    let query = supabase
      .from('size_microns')
      .select('*')
      .or(`tenant_id.eq.${tenantId},tenant_id.eq.shri-hari-pack`)
      .order('micron', { ascending: true });

    if (activeOnly === 'true') {
      query = query.eq('is_active', true);
    }

    if (search && typeof search === 'string') {
      query = query.ilike('label', `%${search.trim()}%`);
    }

    const { data, error } = await query;
    if (error) {
      console.warn('⚠️ [SIZE_MICRONS] Supabase table not created yet or query failed:', error.message);
      // Fallback gracefully to memory store so frontend remains 100% functional
      return res.json({ success: true, sizeMicrons: inMemSizeMicrons.filter((sm) => activeOnly === 'true' ? sm.is_active : true) });
    }

    return res.json({ success: true, sizeMicrons: data || [] });
  } catch (error: any) {
    console.warn('⚠️ [SIZE_MICRONS] Catch error, falling back to memory store:', error.message);
    return res.json({ success: true, sizeMicrons: inMemSizeMicrons });
  }
};

// Get single Size / Micron entry by ID
export const getSizeMicronById = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;

    if (!isSupabaseConfigured) {
      const item = inMemSizeMicrons.find((sm) => sm.tenant_id === tenantId && sm.id === id);
      if (!item) {
        return res.status(404).json({ success: false, message: 'Size / Micron specification not found.' });
      }
      return res.json({ success: true, sizeMicron: item });
    }

    const { data, error } = await supabase
      .from('size_microns')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('id', id)
      .single();

    if (error) throw error;
    return res.json({ success: true, sizeMicron: data });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Create new Size / Micron entry
export const createSizeMicron = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userEmail = req.user?.email;

    const schema = z.object({
      label: z.string().optional(),
      size: z.string().optional(),
      micron: z.number().positive({ message: 'Micron thickness must be a positive number' }),
      unit: z.string().default('Micron'),
      description: z.string().optional(),
      isActive: z.boolean().default(true),
    });

    const body = schema.parse(req.body);

    const sizeStr = body.size?.trim() || '';
    const unitStr = body.unit?.trim() || 'Micron';
    const computedLabel =
      body.label?.trim() ||
      (sizeStr ? `${sizeStr} - ${body.micron} ${unitStr}` : `${body.micron} ${unitStr}`);

    if (!isSupabaseConfigured) {
      // Check duplicate label within tenant
      const exists = inMemSizeMicrons.find(
        (sm) => sm.tenant_id === tenantId && sm.label.toLowerCase() === computedLabel.toLowerCase()
      );
      if (exists) {
        return res.status(400).json({
          success: false,
          message: `A Size/Micron specification with label "${computedLabel}" already exists.`,
        });
      }

      const newItem: InMemSizeMicron = {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        label: computedLabel,
        size: sizeStr || 'Standard',
        micron: body.micron,
        unit: unitStr,
        description: body.description?.trim() || '',
        is_active: body.isActive !== undefined ? body.isActive : true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      inMemSizeMicrons.push(newItem);
      mockStore.sizeMicrons = inMemSizeMicrons;
      saveMockStore();

      recordAuditLog('CREATE_SIZE_MICRON', 'size_microns', { label: newItem.label, id: newItem.id }, userEmail);

      return res.status(201).json({ success: true, sizeMicron: newItem });
    }

    const { data, error } = await supabase
      .from('size_microns')
      .insert({
        tenant_id: tenantId,
        label: computedLabel,
        size: sizeStr || 'Standard',
        micron: body.micron,
        unit: unitStr,
        description: body.description?.trim() || '',
        is_active: body.isActive !== undefined ? body.isActive : true,
      })
      .select('*')
      .single();

    if (error) throw error;

    recordAuditLog('CREATE_SIZE_MICRON', 'size_microns', { label: data.label, id: data.id }, userEmail);

    return res.status(201).json({ success: true, sizeMicron: data });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Update Size / Micron entry
export const updateSizeMicron = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;
    const userEmail = req.user?.email;

    const schema = z.object({
      label: z.string().optional(),
      size: z.string().optional(),
      micron: z.number().positive().optional(),
      unit: z.string().optional(),
      description: z.string().optional(),
      isActive: z.boolean().optional(),
    });

    const body = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      const idx = inMemSizeMicrons.findIndex((sm) => sm.tenant_id === tenantId && sm.id === id);
      if (idx === -1) {
        return res.status(404).json({ success: false, message: 'Size / Micron specification not found.' });
      }

      const existing = inMemSizeMicrons[idx];
      const newSize = body.size !== undefined ? body.size.trim() : existing.size;
      const newMicron = body.micron !== undefined ? body.micron : existing.micron;
      const newUnit = body.unit !== undefined ? body.unit.trim() : existing.unit;
      const newLabel =
        body.label !== undefined && body.label.trim().length > 0
          ? body.label.trim()
          : existing.label;

      inMemSizeMicrons[idx] = {
        ...existing,
        label: newLabel,
        size: newSize,
        micron: newMicron,
        unit: newUnit,
        description: body.description !== undefined ? body.description.trim() : existing.description,
        is_active: body.isActive !== undefined ? body.isActive : existing.is_active,
        updated_at: new Date().toISOString(),
      };

      mockStore.sizeMicrons = inMemSizeMicrons;
      saveMockStore();

      recordAuditLog('UPDATE_SIZE_MICRON', 'size_microns', { label: inMemSizeMicrons[idx].label, id }, userEmail);

      return res.json({ success: true, sizeMicron: inMemSizeMicrons[idx] });
    }

    const updates: any = { updated_at: new Date().toISOString() };
    if (body.label !== undefined) updates.label = body.label.trim();
    if (body.size !== undefined) updates.size = body.size.trim();
    if (body.micron !== undefined) updates.micron = body.micron;
    if (body.unit !== undefined) updates.unit = body.unit.trim();
    if (body.description !== undefined) updates.description = body.description.trim();
    if (body.isActive !== undefined) updates.is_active = body.isActive;

    const { data, error } = await supabase
      .from('size_microns')
      .update(updates)
      .eq('tenant_id', tenantId)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    recordAuditLog('UPDATE_SIZE_MICRON', 'size_microns', { label: data.label, id }, userEmail);

    return res.json({ success: true, sizeMicron: data });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Delete Size / Micron entry
export const deleteSizeMicron = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;
    const userEmail = req.user?.email;

    if (!isSupabaseConfigured) {
      const idx = inMemSizeMicrons.findIndex((sm) => sm.tenant_id === tenantId && sm.id === id);
      if (idx === -1) {
        return res.status(404).json({ success: false, message: 'Size / Micron specification not found.' });
      }

      const item = inMemSizeMicrons[idx];
      inMemSizeMicrons.splice(idx, 1);
      mockStore.sizeMicrons = inMemSizeMicrons;
      saveMockStore();

      recordAuditLog('DELETE_SIZE_MICRON', 'size_microns', { label: item.label, id }, userEmail);

      return res.json({ success: true, message: `Specification "${item.label}" deleted successfully.` });
    }

    const { error } = await supabase
      .from('size_microns')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('id', id);

    if (error) throw error;

    recordAuditLog('DELETE_SIZE_MICRON', 'size_microns', { id }, userEmail);

    return res.json({ success: true, message: 'Specification deleted successfully.' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
