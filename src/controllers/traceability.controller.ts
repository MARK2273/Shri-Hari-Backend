import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';

// Full End-to-End Traceability (REP-07)
export const getTraceability = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    const { batchNumber, orderNumber, lotNumber } = req.query;

    if (!isSupabaseConfigured) {
      return res.json({ success: true, traceability: null, records: [] });
    }

    // In connected Supabase: query production batch by batch number, order, or lot
    let query = supabase
      .from('production_batches')
      .select(`
        *,
        customer_orders (
          id, order_number, order_date, required_delivery_date, status,
          customers (name, code, delivery_address)
        ),
        products (code, name, unit),
        product_recipes (version),
        production_material_consumption (
          planned_quantity_kg, actual_quantity_kg, consumed_at,
          materials (code, name),
          material_batches (
            batch_number, supplier_lot_number, receipt_date,
            suppliers (name, code)
          )
        ),
        finished_goods_batches (
          id, batch_number, quantity_produced_kg, quantity_on_hand_kg, quantity_dispatched_kg, status
        )
      `)
      .eq('tenant_id', tenantId);

    if (batchNumber) query = query.eq('batch_number', batchNumber);

    const { data: records, error } = await query;
    if (error) throw error;

    return res.json({ success: true, records });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
