import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { z } from 'zod';
import crypto from 'crypto';
import { mockStore, saveMockStore } from '../utils/mockStore';

const getTenantId = (req: Request): string =>
  (req.tenantId || process.env.DEFAULT_TENANT_SLUG || '0f866809-06c3-4771-8b93-4f2253c9b6b1') as string;

// In-Memory Fallback Arrays linked to mockStore
export let inMemScrapEntries: any[] = mockStore.scrapEntries || [];
export let inMemScrapSales: any[] = mockStore.scrapSales || [];

// Helper to compute on-floor scrap
export async function getOnFloorScrapCalculations(tenantId: string): Promise<{
  total_generated_kg: number;
  total_sold_kg: number;
  on_floor_scrap_kg: number;
  total_sales_revenue: number;
  average_rate_per_kg: number;
}> {
  if (!isSupabaseConfigured) {
    const entries = (mockStore.scrapEntries || []).filter(
      (e: any) => e.tenant_id === tenantId || tenantId === 'shri-hari-pack'
    );
    const sales = (mockStore.scrapSales || []).filter(
      (s: any) => s.tenant_id === tenantId || tenantId === 'shri-hari-pack'
    );

    const totalGenerated = entries.reduce((acc: number, e: any) => acc + (Number(e.quantity_kg) || 0), 0);
    const totalSold = sales.reduce((acc: number, s: any) => acc + (Number(s.quantity_kg) || 0), 0);
    const totalRevenue = sales.reduce((acc: number, s: any) => acc + (Number(s.total_amount) || 0), 0);
    const onFloor = Math.max(0, Number((totalGenerated - totalSold).toFixed(2)));
    const avgRate = totalSold > 0 ? Number((totalRevenue / totalSold).toFixed(2)) : 0;

    return {
      total_generated_kg: Number(totalGenerated.toFixed(2)),
      total_sold_kg: Number(totalSold.toFixed(2)),
      on_floor_scrap_kg: onFloor,
      total_sales_revenue: Number(totalRevenue.toFixed(2)),
      average_rate_per_kg: avgRate,
    };
  }

  // Supabase queries
  const { data: entries, error: entErr } = await supabase
    .from('scrap_entries')
    .select('quantity_kg, scrap_type')
    .eq('tenant_id', tenantId);

  const { data: sales, error: salErr } = await supabase
    .from('scrap_sales')
    .select('quantity_kg, rate_per_kg, total_amount')
    .eq('tenant_id', tenantId);

  if (entErr) console.error('[getOnFloorScrapCalculations] entries error:', entErr);
  if (salErr) console.error('[getOnFloorScrapCalculations] sales error:', salErr);

  const totalGenerated = (entries || []).reduce((acc: number, e: any) => acc + (Number(e.quantity_kg) || 0), 0);
  const totalSold = (sales || []).reduce((acc: number, s: any) => acc + (Number(s.quantity_kg) || 0), 0);
  const totalRevenue = (sales || []).reduce((acc: number, s: any) => acc + (Number(s.total_amount) || 0), 0);
  const onFloor = Math.max(0, Number((totalGenerated - totalSold).toFixed(2)));
  const avgRate = totalSold > 0 ? Number((totalRevenue / totalSold).toFixed(2)) : 0;

  return {
    total_generated_kg: Number(totalGenerated.toFixed(2)),
    total_sold_kg: Number(totalSold.toFixed(2)),
    on_floor_scrap_kg: onFloor,
    total_sales_revenue: Number(totalRevenue.toFixed(2)),
    average_rate_per_kg: avgRate,
  };
}

// 1. GET /api/scrap/summary
export const getScrapSummary = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const calcs = await getOnFloorScrapCalculations(tenantId);

    if (!isSupabaseConfigured) {
      const entries = (mockStore.scrapEntries || []).filter(
        (e: any) => e.tenant_id === tenantId || tenantId === 'shri-hari-pack'
      );
      const sales = (mockStore.scrapSales || []).filter(
        (s: any) => s.tenant_id === tenantId || tenantId === 'shri-hari-pack'
      );

      const byTypeMap: Record<string, number> = {};
      entries.forEach((e: any) => {
        const t = e.scrap_type || 'General Scrap';
        byTypeMap[t] = (byTypeMap[t] || 0) + Number(e.quantity_kg || 0);
      });

      return res.json({
        success: true,
        summary: {
          ...calcs,
          entries_count: entries.length,
          sales_count: sales.length,
          scrap_by_type: byTypeMap,
          recent_entries: entries.slice(0, 5),
          recent_sales: sales.slice(0, 5),
        },
      });
    }

    const { data: recentEntries } = await supabase
      .from('scrap_entries')
      .select('*, production_batches(batch_number)')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(5);

    const { data: recentSales } = await supabase
      .from('scrap_sales')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(5);

    const { data: allEntries } = await supabase
      .from('scrap_entries')
      .select('scrap_type, quantity_kg')
      .eq('tenant_id', tenantId);

    const byTypeMap: Record<string, number> = {};
    (allEntries || []).forEach((e: any) => {
      const t = e.scrap_type || 'General Scrap';
      byTypeMap[t] = Number(((byTypeMap[t] || 0) + Number(e.quantity_kg || 0)).toFixed(2));
    });

    return res.json({
      success: true,
      summary: {
        ...calcs,
        entries_count: (allEntries || []).length,
        sales_count: (recentSales || []).length,
        scrap_by_type: byTypeMap,
        recent_entries: recentEntries || [],
        recent_sales: recentSales || [],
      },
    });
  } catch (error: any) {
    console.error('[getScrapSummary] error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 2. GET /api/scrap/entries
export const getScrapEntries = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    if (!isSupabaseConfigured) {
      const entries = (mockStore.scrapEntries || []).filter(
        (e: any) => e.tenant_id === tenantId || tenantId === 'shri-hari-pack'
      );
      return res.json({ success: true, entries });
    }

    const { data: entries, error } = await supabase
      .from('scrap_entries')
      .select(`
        *,
        production_batches (id, batch_number, status),
        products (id, code, name)
      `)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, entries: entries || [] });
  } catch (error: any) {
    console.error('[getScrapEntries] error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 3. POST /api/scrap/entries (Manual on-floor scrap logging)
export const createScrapEntry = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = req.user?.id;

    const schema = z.object({
      quantityKg: z.number().positive('Quantity must be greater than 0'),
      scrapType: z.string().min(1, 'Please specify scrap type'),
      sourceType: z.string().default('manual_sweep'),
      productionBatchId: z.string().optional(),
      productId: z.string().optional(),
      entryDate: z.string().optional(),
      notes: z.string().optional(),
    });

    const body = schema.parse(req.body);
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const entryNumber = `SCRAP-IN-${dateStr}-${Math.floor(100 + Math.random() * 900)}`;

    if (!isSupabaseConfigured) {
      const newEntry = {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        entry_number: entryNumber,
        entry_date: body.entryDate || new Date().toISOString().split('T')[0],
        source_type: body.sourceType,
        production_batch_id: body.productionBatchId || null,
        product_id: body.productId || null,
        scrap_type: body.scrapType,
        quantity_kg: body.quantityKg,
        notes: body.notes || '',
        recorded_by: userId || null,
        created_at: new Date().toISOString(),
      };

      if (!mockStore.scrapEntries) mockStore.scrapEntries = [];
      mockStore.scrapEntries.unshift(newEntry);
      saveMockStore();

      const calcs = await getOnFloorScrapCalculations(tenantId);
      return res.status(201).json({
        success: true,
        message: `Successfully logged ${body.quantityKg} kg of ${body.scrapType}. On-floor scrap is now ${calcs.on_floor_scrap_kg} kg.`,
        entry: newEntry,
        on_floor_scrap_kg: calcs.on_floor_scrap_kg,
      });
    }

    const { data: entry, error } = await supabase
      .from('scrap_entries')
      .insert({
        tenant_id: tenantId,
        entry_number: entryNumber,
        entry_date: body.entryDate || new Date().toISOString().split('T')[0],
        source_type: body.sourceType,
        production_batch_id: body.productionBatchId || null,
        product_id: body.productId || null,
        scrap_type: body.scrapType,
        quantity_kg: body.quantityKg,
        notes: body.notes || null,
        recorded_by: userId || null,
      })
      .select('*')
      .single();

    if (error) throw error;

    // Audit log
    await supabase.from('audit_logs').insert({
      tenant_id: tenantId,
      user_id: userId,
      action: 'LOG_SCRAP_ENTRY',
      entity_name: 'scrap_entries',
      entity_id: entry.id,
      new_values: { entryNumber, quantityKg: body.quantityKg, scrapType: body.scrapType },
    });

    const calcs = await getOnFloorScrapCalculations(tenantId);
    return res.status(201).json({
      success: true,
      message: `Successfully logged ${body.quantityKg} kg of ${body.scrapType}. On-floor scrap is now ${calcs.on_floor_scrap_kg} kg.`,
      entry,
      on_floor_scrap_kg: calcs.on_floor_scrap_kg,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    console.error('[createScrapEntry] error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 4. GET /api/scrap/sales
export const getScrapSales = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    if (!isSupabaseConfigured) {
      const sales = (mockStore.scrapSales || []).filter(
        (s: any) => s.tenant_id === tenantId || tenantId === 'shri-hari-pack'
      );
      return res.json({ success: true, sales });
    }

    const { data: sales, error } = await supabase
      .from('scrap_sales')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, sales: sales || [] });
  } catch (error: any) {
    console.error('[getScrapSales] error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 5. POST /api/scrap/sales (Sell scrap to third-party vendor)
export const createScrapSale = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = req.user?.id;

    const schema = z.object({
      buyerName: z.string().min(2, 'Vendor/Buyer name is required'),
      buyerPhone: z.string().optional(),
      buyerAddress: z.string().optional(),
      scrapType: z.string().default('Mixed Production Scrap'),
      quantityKg: z.number().positive('Quantity sold must be greater than 0'),
      ratePerKg: z.number().positive('Selling rate per kg must be greater than 0'),
      paymentMode: z.enum(['cash', 'upi', 'bank_transfer', 'cheque', 'pending']).default('cash'),
      paymentStatus: z.enum(['received', 'pending', 'partial']).default('received'),
      vehicleNumber: z.string().optional(),
      driverName: z.string().optional(),
      gatePassNumber: z.string().optional(),
      notes: z.string().optional(),
      saleDate: z.string().optional(),
    });

    const body = schema.parse(req.body);

    // Strict validation: Check on-floor available scrap
    const calcs = await getOnFloorScrapCalculations(tenantId);
    if (body.quantityKg > calcs.on_floor_scrap_kg) {
      return res.status(400).json({
        success: false,
        message: `Cannot sell ${body.quantityKg} kg of scrap. Only ${calcs.on_floor_scrap_kg} kg is currently available on the factory floor.`,
        available_on_floor_kg: calcs.on_floor_scrap_kg,
      });
    }

    const totalAmount = Number((body.quantityKg * body.ratePerKg).toFixed(2));
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const saleNumber = `SCRAP-SALE-${dateStr}-${Math.floor(100 + Math.random() * 900)}`;

    if (!isSupabaseConfigured) {
      const newSale = {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        sale_number: saleNumber,
        sale_date: body.saleDate || new Date().toISOString().split('T')[0],
        buyer_name: body.buyerName.trim(),
        buyer_phone: body.buyerPhone?.trim() || null,
        buyer_address: body.buyerAddress?.trim() || null,
        scrap_type: body.scrapType,
        quantity_kg: body.quantityKg,
        rate_per_kg: body.ratePerKg,
        total_amount: totalAmount,
        payment_mode: body.paymentMode,
        payment_status: body.paymentStatus,
        vehicle_number: body.vehicleNumber?.trim() || null,
        driver_name: body.driverName?.trim() || null,
        gate_pass_number: body.gatePassNumber?.trim() || null,
        notes: body.notes || '',
        created_by: userId || null,
        created_at: new Date().toISOString(),
      };

      if (!mockStore.scrapSales) mockStore.scrapSales = [];
      mockStore.scrapSales.unshift(newSale);
      saveMockStore();

      const newCalcs = await getOnFloorScrapCalculations(tenantId);
      return res.status(201).json({
        success: true,
        message: `Successfully sold ${body.quantityKg} kg of scrap to ${body.buyerName} for ₹${totalAmount.toLocaleString('en-IN')}. Remaining on-floor scrap: ${newCalcs.on_floor_scrap_kg} kg.`,
        sale: newSale,
        on_floor_scrap_kg: newCalcs.on_floor_scrap_kg,
      });
    }

    const { data: sale, error } = await supabase
      .from('scrap_sales')
      .insert({
        tenant_id: tenantId,
        sale_number: saleNumber,
        sale_date: body.saleDate || new Date().toISOString().split('T')[0],
        buyer_name: body.buyerName.trim(),
        buyer_phone: body.buyerPhone?.trim() || null,
        buyer_address: body.buyerAddress?.trim() || null,
        scrap_type: body.scrapType,
        quantity_kg: body.quantityKg,
        rate_per_kg: body.ratePerKg,
        total_amount: totalAmount,
        payment_mode: body.paymentMode,
        payment_status: body.paymentStatus,
        vehicle_number: body.vehicleNumber?.trim() || null,
        driver_name: body.driverName?.trim() || null,
        gate_pass_number: body.gatePassNumber?.trim() || null,
        notes: body.notes || null,
        created_by: userId || null,
      })
      .select('*')
      .single();

    if (error) throw error;

    // Audit log
    await supabase.from('audit_logs').insert({
      tenant_id: tenantId,
      user_id: userId,
      action: 'SELL_SCRAP_TO_VENDOR',
      entity_name: 'scrap_sales',
      entity_id: sale.id,
      new_values: {
        saleNumber,
        buyerName: body.buyerName,
        quantityKg: body.quantityKg,
        ratePerKg: body.ratePerKg,
        totalAmount,
      },
    });

    const newCalcs = await getOnFloorScrapCalculations(tenantId);
    return res.status(201).json({
      success: true,
      message: `Successfully sold ${body.quantityKg} kg of scrap to ${body.buyerName} for ₹${totalAmount.toLocaleString('en-IN')}. Remaining on-floor scrap: ${newCalcs.on_floor_scrap_kg} kg.`,
      sale,
      on_floor_scrap_kg: newCalcs.on_floor_scrap_kg,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    console.error('[createScrapSale] error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 6. DELETE /api/scrap/sales/:id (Cancel / Revert Scrap Sale)
export const deleteScrapSale = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = req.user?.id;
    const { id } = req.params;

    if (!isSupabaseConfigured) {
      const idx = (mockStore.scrapSales || []).findIndex(
        (s: any) => s.id === id && (s.tenant_id === tenantId || tenantId === 'shri-hari-pack')
      );
      if (idx === -1) {
        return res.status(404).json({ success: false, message: 'Scrap sale record not found' });
      }
      const removed = mockStore.scrapSales.splice(idx, 1)[0];
      saveMockStore();

      const newCalcs = await getOnFloorScrapCalculations(tenantId);
      return res.json({
        success: true,
        message: `Scrap sale ${removed.sale_number} cancelled. ${removed.quantity_kg} kg restored to on-floor scrap stock.`,
        on_floor_scrap_kg: newCalcs.on_floor_scrap_kg,
      });
    }

    const { data: sale, error: fetchErr } = await supabase
      .from('scrap_sales')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !sale) {
      return res.status(404).json({ success: false, message: 'Scrap sale record not found' });
    }

    const { error: delErr } = await supabase.from('scrap_sales').delete().eq('id', id);
    if (delErr) throw delErr;

    // Audit log
    await supabase.from('audit_logs').insert({
      tenant_id: tenantId,
      user_id: userId,
      action: 'CANCEL_SCRAP_SALE',
      entity_name: 'scrap_sales',
      entity_id: id,
      new_values: { cancelledSale: sale },
    });

    const newCalcs = await getOnFloorScrapCalculations(tenantId);
    return res.json({
      success: true,
      message: `Scrap sale ${sale.sale_number} cancelled. ${sale.quantity_kg} kg restored to on-floor scrap stock.`,
      on_floor_scrap_kg: newCalcs.on_floor_scrap_kg,
    });
  } catch (error: any) {
    console.error('[deleteScrapSale] error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
