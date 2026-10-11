import { Request, Response } from 'express';
import { supabase, supabaseAdmin, isSupabaseConfigured } from '../config/supabase';
import { z } from 'zod';

// List Tenants (Platform Admin)
export const getTenants = async (req: Request, res: Response) => {
  try {
    if (!isSupabaseConfigured) {
      return res.json({
        success: true,
        tenants: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            tenant_id: 'shri-hari-pack',
            name: 'Shri Hari Packaging Factory',
            status: 'active',
            address: 'Plot 45, GIDC Industrial Estate, Vapi, Gujarat',
            contact_email: 'info@shriharipackaging.com',
            contact_phone: '+91 98765 43210'
          }
        ]
      });
    }

    const dbClient = supabaseAdmin || supabase;
    const { data: tenants, error } = await dbClient
      .from('tenants')
      .select('*, tenant_settings(*)')
      .order('name', { ascending: true });

    if (error) throw error;
    return res.json({ success: true, tenants });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Create new Factory Tenant (TEN-01, TEN-02, TEN-08)
export const createTenant = async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      tenantSlug: z.string().min(3).regex(/^[a-z0-9-]+$/),
      name: z.string().min(2),
      address: z.string().optional(),
      contactEmail: z.string().email().optional(),
      contactPhone: z.string().optional()
    });

    const body = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      return res.status(201).json({
        success: true,
        tenant: { id: `tenant-${Date.now()}`, tenant_id: body.tenantSlug, name: body.name, status: 'active' }
      });
    }

    const { data: tenant, error: tErr } = await supabase
      .from('tenants')
      .insert({
        tenant_id: body.tenantSlug,
        name: body.name,
        address: body.address,
        contact_email: body.contactEmail,
        contact_phone: body.contactPhone,
        status: 'active'
      })
      .select('*')
      .single();

    if (tErr) throw tErr;

    // Create default tenant settings
    await supabase.from('tenant_settings').insert({
      tenant_id: tenant.id,
      standard_weight_unit: 'kg',
      allow_negative_stock: false,
      min_stock_alert_enabled: true,
      suggest_fifo_batch_allocation: true
    });

    return res.status(201).json({ success: true, tenant });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Update Tenant status (Activate, Suspend, Deactivate) (TEN-01, TEN-09)
export const updateTenantStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = z.object({ status: z.enum(['active', 'suspended', 'deactivated']) }).parse(req.body);

    if (!isSupabaseConfigured) {
      return res.json({ success: true, message: `Tenant status updated to ${status} (mock mode)` });
    }

    const { data: tenant, error } = await supabase
      .from('tenants')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ success: true, tenant });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
