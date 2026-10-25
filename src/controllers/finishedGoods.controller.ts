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
  size_micron?: string;
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
        const sizeMicron = b.size_micron || (pb as any)?.size_micron || (ord as any)?.size_micron || 'Standard';
        return {
          ...b,
          size_micron: sizeMicron,
          products: prod ? { id: prod.id, code: prod.code, name: prod.name, unit: prod.unit } : null,
          production_batches: pb
            ? {
                id: pb.id,
                batch_number: pb.batch_number,
                operator_name: pb.operator_name,
                order_id: pb.order_id,
                size_micron: (pb as any).size_micron || sizeMicron,
                customer_orders: ord ? { order_number: ord.order_number, size_micron: (ord as any).size_micron } : null,
              }
            : null,
        };
      });

      const productMap: Record<string, any> = {};
      const sizeMicronMap: Record<string, any> = {};

      enrichedBatches.forEach((b: any) => {
        const pid = b.product_id;
        const spec = b.size_micron || 'Standard';

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
            specs_breakdown: {},
          };
        }
        productMap[pid].total_on_hand_kg += Number(b.quantity_on_hand_kg || 0);
        productMap[pid].total_reserved_kg += Number(b.quantity_reserved_kg || 0);
        productMap[pid].total_dispatched_kg += Number(b.quantity_dispatched_kg || 0);
        productMap[pid].available_kg = productMap[pid].total_on_hand_kg - productMap[pid].total_reserved_kg;

        if (!productMap[pid].specs_breakdown[spec]) {
          productMap[pid].specs_breakdown[spec] = {
            size_micron: spec,
            on_hand_kg: 0,
            reserved_kg: 0,
            dispatched_kg: 0,
            available_kg: 0,
            batch_count: 0,
          };
        }
        productMap[pid].specs_breakdown[spec].on_hand_kg += Number(b.quantity_on_hand_kg || 0);
        productMap[pid].specs_breakdown[spec].reserved_kg += Number(b.quantity_reserved_kg || 0);
        productMap[pid].specs_breakdown[spec].dispatched_kg += Number(b.quantity_dispatched_kg || 0);
        productMap[pid].specs_breakdown[spec].available_kg =
          productMap[pid].specs_breakdown[spec].on_hand_kg - productMap[pid].specs_breakdown[spec].reserved_kg;
        productMap[pid].specs_breakdown[spec].batch_count += 1;

        if (!sizeMicronMap[spec]) {
          sizeMicronMap[spec] = {
            size_micron: spec,
            total_on_hand_kg: 0,
            total_reserved_kg: 0,
            total_dispatched_kg: 0,
            available_kg: 0,
            batch_count: 0,
            products: {},
          };
        }
        sizeMicronMap[spec].total_on_hand_kg += Number(b.quantity_on_hand_kg || 0);
        sizeMicronMap[spec].total_reserved_kg += Number(b.quantity_reserved_kg || 0);
        sizeMicronMap[spec].total_dispatched_kg += Number(b.quantity_dispatched_kg || 0);
        sizeMicronMap[spec].available_kg = sizeMicronMap[spec].total_on_hand_kg - sizeMicronMap[spec].total_reserved_kg;
        sizeMicronMap[spec].batch_count += 1;
        if (!sizeMicronMap[spec].products[pid]) {
          sizeMicronMap[spec].products[pid] = {
            product_id: pid,
            product_name: b.products?.name || 'Product',
            product_code: b.products?.code || '',
            available_kg: 0,
          };
        }
        sizeMicronMap[spec].products[pid].available_kg +=
          Number(b.quantity_on_hand_kg || 0) - Number(b.quantity_reserved_kg || 0);
      });

      const summary = Object.values(productMap).map((p: any) => ({
        ...p,
        specs: Object.values(p.specs_breakdown),
      }));

      const sizeMicronSummary = Object.values(sizeMicronMap).map((s: any) => ({
        ...s,
        products: Object.values(s.products),
      }));

      return res.json({
        success: true,
        summary,
        sizeMicronSummary,
        batches: enrichedBatches,
      });
    }

    // Fetch FG batches from Supabase
    const { data: batches, error } = await supabase
      .from('finished_goods_batches')
      .select(`
        *,
        products (id, code, name, unit),
        production_batches (id, batch_number, operator_name, order_id, size_micron, customer_orders(order_number, size_micron))
      `)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const normalizedBatches = (batches || []).map((b: any) => {
      const sizeMicron =
        b.size_micron ||
        b.production_batches?.size_micron ||
        b.production_batches?.customer_orders?.size_micron ||
        'Standard';
      return {
        ...b,
        size_micron: sizeMicron,
      };
    });

    // Aggregate on-hand by product and by size & micron
    const productMap: Record<string, any> = {};
    const sizeMicronMap: Record<string, any> = {};

    normalizedBatches.forEach((b: any) => {
      const pid = b.product_id;
      const spec = b.size_micron || 'Standard';

      if (!productMap[pid]) {
        productMap[pid] = {
          product_id: pid,
          product_code: b.products?.code,
          product_name: b.products?.name,
          unit: b.products?.unit,
          total_on_hand_kg: 0,
          total_reserved_kg: 0,
          total_dispatched_kg: 0,
          available_kg: 0,
          specs_breakdown: {},
        };
      }
      productMap[pid].total_on_hand_kg += Number(b.quantity_on_hand_kg || 0);
      productMap[pid].total_reserved_kg += Number(b.quantity_reserved_kg || 0);
      productMap[pid].total_dispatched_kg += Number(b.quantity_dispatched_kg || 0);
      productMap[pid].available_kg = productMap[pid].total_on_hand_kg - productMap[pid].total_reserved_kg;

      if (!productMap[pid].specs_breakdown[spec]) {
        productMap[pid].specs_breakdown[spec] = {
          size_micron: spec,
          on_hand_kg: 0,
          reserved_kg: 0,
          dispatched_kg: 0,
          available_kg: 0,
          batch_count: 0,
        };
      }
      productMap[pid].specs_breakdown[spec].on_hand_kg += Number(b.quantity_on_hand_kg || 0);
      productMap[pid].specs_breakdown[spec].reserved_kg += Number(b.quantity_reserved_kg || 0);
      productMap[pid].specs_breakdown[spec].dispatched_kg += Number(b.quantity_dispatched_kg || 0);
      productMap[pid].specs_breakdown[spec].available_kg =
        productMap[pid].specs_breakdown[spec].on_hand_kg - productMap[pid].specs_breakdown[spec].reserved_kg;
      productMap[pid].specs_breakdown[spec].batch_count += 1;

      // Group by Size & Micron
      if (!sizeMicronMap[spec]) {
        sizeMicronMap[spec] = {
          size_micron: spec,
          total_on_hand_kg: 0,
          total_reserved_kg: 0,
          total_dispatched_kg: 0,
          available_kg: 0,
          batch_count: 0,
          products: {},
        };
      }
      sizeMicronMap[spec].total_on_hand_kg += Number(b.quantity_on_hand_kg || 0);
      sizeMicronMap[spec].total_reserved_kg += Number(b.quantity_reserved_kg || 0);
      sizeMicronMap[spec].total_dispatched_kg += Number(b.quantity_dispatched_kg || 0);
      sizeMicronMap[spec].available_kg = sizeMicronMap[spec].total_on_hand_kg - sizeMicronMap[spec].total_reserved_kg;
      sizeMicronMap[spec].batch_count += 1;
      if (!sizeMicronMap[spec].products[pid]) {
        sizeMicronMap[spec].products[pid] = {
          product_id: pid,
          product_name: b.products?.name || 'Product',
          product_code: b.products?.code || '',
          available_kg: 0,
        };
      }
      sizeMicronMap[spec].products[pid].available_kg +=
        Number(b.quantity_on_hand_kg || 0) - Number(b.quantity_reserved_kg || 0);
    });

    const summary = Object.values(productMap).map((p: any) => ({
      ...p,
      specs: Object.values(p.specs_breakdown),
    }));

    const sizeMicronSummary = Object.values(sizeMicronMap).map((s: any) => ({
      ...s,
      products: Object.values(s.products),
    }));

    return res.json({
      success: true,
      summary,
      sizeMicronSummary,
      batches: normalizedBatches,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
