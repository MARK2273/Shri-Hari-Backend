import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { inMemProducts } from './products.controller';
import { inMemProductionBatches } from './production.controller';
import { inMemOrders } from './orders.controller';

export interface InMemFGBatch {
  id: string;
  tenant_id: string;
  product_id: string;
  production_batch_id: string;
  batch_number: string;
  quantity_on_hand_kg: number;
  quantity_reserved_kg: number;
  quantity_dispatched_kg: number;
  status: string;
  created_at: string;
}

import { mockStore, saveMockStore } from '../utils/mockStore';

export let inMemFGBatches: InMemFGBatch[] = mockStore.fgBatches;

export const getFinishedGoodsInventory = async (req: Request, res: Response) => {
  try {
    const tenantId = (req.tenantId || process.env.DEFAULT_TENANT_SLUG || 'shri-hari-pack') as string;

    if (!isSupabaseConfigured) {
      const tenantBatches = inMemFGBatches.filter((b) => b.tenant_id === tenantId);
      const enrichedBatches = tenantBatches.map((b) => {
        const prod = inMemProducts.find((p) => p.id === b.product_id);
        const pb = inMemProductionBatches.find((p) => p.id === b.production_batch_id);
        const ord = pb ? inMemOrders.find((o) => o.id === pb.order_id) : null;
        return {
          ...b,
          products: prod ? { id: prod.id, code: prod.code, name: prod.name, unit: prod.unit } : null,
          production_batches: pb
            ? {
                id: pb.id,
                batch_number: pb.batch_number,
                order_id: pb.order_id,
                customer_orders: ord ? { order_number: ord.order_number } : null,
              }
            : null,
        };
      });

      const productMap: Record<string, any> = {};
      enrichedBatches.forEach((b: any) => {
        const pid = b.product_id;
        if (!productMap[pid]) {
          productMap[pid] = {
            product_id: pid,
            product_code: b.products?.code,
            product_name: b.products?.name,
            unit: b.products?.unit || 'kg',
            total_on_hand_kg: 0,
            total_reserved_kg: 0,
            total_dispatched_kg: 0,
            available_kg: 0,
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
        batches: enrichedBatches,
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
