import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';

export const getFinishedGoodsInventory = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;

    if (!isSupabaseConfigured) {
      return res.json({
        success: true,
        summary: [],
        batches: []
      });
    }

    // Fetch FG batches
    const { data: batches, error } = await supabase
      .from('finished_goods_batches')
      .select(`
        *,
        products (id, code, name, unit),
        production_batches (id, batch_number, order_id, customer_orders(order_number))
      `)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Aggregate on-hand by product (FG-04)
    const productMap: Record<string, any> = {};
    (batches || []).forEach((b: any) => {
      const pid = b.product_id;
      if (!productMap[pid]) {
        productMap[pid] = {
          product_id: pid,
          product_code: b.products?.code,
          product_name: b.products?.name,
          unit: b.products?.unit,
          total_on_hand_kg: 0,
          total_reserved_kg: 0,
          total_dispatched_kg: 0,
          available_kg: 0
        };
      }
      productMap[pid].total_on_hand_kg += Number(b.quantity_on_hand_kg);
      productMap[pid].total_reserved_kg += Number(b.quantity_reserved_kg || 0);
      productMap[pid].total_dispatched_kg += Number(b.quantity_dispatched_kg || 0);
      productMap[pid].available_kg = productMap[pid].total_on_hand_kg - productMap[pid].total_reserved_kg;
    });

    return res.json({
      success: true,
      summary: Object.values(productMap),
      batches
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
