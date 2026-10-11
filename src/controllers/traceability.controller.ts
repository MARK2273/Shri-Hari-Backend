import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { mockStore } from '../utils/mockStore';

const getTenantId = (req: Request): string =>
  (req.tenantId || process.env.DEFAULT_TENANT_SLUG || 'shri-hari-pack') as string;

// Full End-to-End Traceability (REP-07)
export const getTraceability = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { batchNumber, orderNumber, lotNumber, q } = req.query;
    const rawSearch = (batchNumber || orderNumber || lotNumber || q || '') as string;
    const queryTerm = rawSearch.trim().toLowerCase();

    if (!isSupabaseConfigured) {
      const batches = mockStore.productionBatches.filter((b: any) => b.tenant_id === tenantId);

      // Search by batchNumber, orderNumber, or material lot
      let matchedBatch: any = null;
      if (queryTerm) {
        matchedBatch = batches.find((b: any) => {
          const matchBatch = b.batch_number?.toLowerCase().includes(queryTerm);
          const matchOrder = b.customer_orders?.order_number?.toLowerCase().includes(queryTerm);
          const matchConsump = b.production_material_consumption?.some((c: any) =>
            c.material_batches?.batch_number?.toLowerCase().includes(queryTerm) ||
            c.material_batches?.supplier_lot_number?.toLowerCase().includes(queryTerm) ||
            c.materials?.name?.toLowerCase().includes(queryTerm) ||
            c.materials?.code?.toLowerCase().includes(queryTerm)
          );
          return matchBatch || matchOrder || matchConsump;
        });
      }

      // Default to the first (latest) batch if query empty or fallback
      if (!matchedBatch && batches.length > 0) {
        matchedBatch = batches[0];
      }

      if (!matchedBatch) {
        return res.json({
          success: true,
          traceability: null,
          records: [],
          availableBatches: batches.map((b: any) => b.batch_number),
        });
      }

      // Enrich matched batch
      const ord = mockStore.orders.find(
        (o: any) => o.id === matchedBatch.order_id || o.order_number === matchedBatch.order_id
      );
      const cust = ord?.customer_id
        ? mockStore.customers.find((c: any) => c.id === ord.customer_id)
        : ord?.customers || matchedBatch.customer_orders?.customers;
      const prod =
        mockStore.products.find((p: any) => p.id === matchedBatch.product_id) ||
        matchedBatch.products;
      const outputs = matchedBatch.production_outputs?.[0];
      const acceptedKg = Number(
        outputs?.accepted_kg || matchedBatch.accepted_output_kg || matchedBatch.planned_quantity_kg || 0
      );
      const wasteKg = Number(outputs?.waste_kg || matchedBatch.waste_kg || 0);
      const plannedKg = Number(matchedBatch.planned_quantity_kg || 1);
      const yieldPct = ((acceptedKg / plannedKg) * 100).toFixed(1);

      // Raw material consumption details
      const consumption = matchedBatch.production_material_consumption || [];
      const totalInputKg =
        consumption.reduce((sum: number, c: any) => sum + (Number(c.actual_quantity_kg) || 0), 0) ||
        plannedKg;

      const rawLots = consumption.map((c: any) => {
        const mat = mockStore.materials.find((m: any) => m.id === c.material_id) || c.materials;
        const mb = mockStore.batches.find((b: any) => b.id === c.material_batch_id) || c.material_batches;
        const actualKg = Number(c.actual_quantity_kg) || Number(c.planned_quantity_kg) || 0;
        return {
          material_id: c.material_id,
          material_name: mat?.name || 'Raw Polymer Material',
          material_code: mat?.code || 'MAT-RAW',
          batch_number: mb?.batch_number || 'MB-LOT-01',
          supplier: mb?.supplier_lot_number
            ? `Supplier Lot: ${mb.supplier_lot_number}`
            : mb?.suppliers?.name || 'Approved Polymer Vendor',
          supplier_lot_number: mb?.supplier_lot_number || null,
          consumed_kg: actualKg,
          planned_kg: Number(c.planned_quantity_kg) || actualKg,
          contribution_pct: totalInputKg > 0 ? ((actualKg / totalInputKg) * 100).toFixed(1) : '0',
        };
      });

      // Finished goods batch
      const fgBatch = mockStore.fgBatches.find(
        (fg: any) =>
          fg.production_batch_id === matchedBatch.id ||
          fg.batch_number === `FG-${matchedBatch.batch_number.replace('PB-', '')}`
      );

      // Delivery / dispatch
      const dispatchDelivery = mockStore.deliveries.find(
        (d: any) => d.order_id === matchedBatch.order_id
      );

      const record = {
        id: matchedBatch.id,
        batch_number: matchedBatch.batch_number,
        status: matchedBatch.status,
        planned_quantity_kg: plannedKg,
        accepted_output_kg: acceptedKg,
        waste_kg: wasteKg,
        yield_percentage: yieldPct,
        start_time: matchedBatch.start_time,
        end_time: matchedBatch.end_time,
        customer_order: {
          id: ord?.id,
          order_number: ord?.order_number || matchedBatch.customer_orders?.order_number || 'ORD-UNKNOWN',
          customer_name: cust?.name || 'Customer Account',
          customer_code: cust?.code,
          delivery_address: cust?.delivery_address || 'Factory Shipping Dock',
          order_date: ord?.order_date,
          required_delivery_date: ord?.required_delivery_date,
          status: ord?.status || 'in_production',
          total_requested_weight_kg: ord?.total_requested_weight_kg || plannedKg,
        },
        customer_orders: {
          id: ord?.id,
          order_number: ord?.order_number || matchedBatch.customer_orders?.order_number,
          customers: {
            name: cust?.name || 'Customer Account',
            delivery_address: cust?.delivery_address,
          },
        },
        products: {
          id: prod?.id,
          code: prod?.code || 'PRD-AUTO',
          name: prod?.name || 'Finished Packaging Product',
          unit: prod?.unit || 'kg',
        },
        product_recipes: matchedBatch.product_recipes || { version: 1 },
        production_batch: {
          id: matchedBatch.id,
          batch_number: matchedBatch.batch_number,
          status: matchedBatch.status,
          planned_quantity_kg: plannedKg,
          accepted_output_kg: acceptedKg,
          waste_kg: wasteKg,
          yield_pct: yieldPct,
        },
        raw_material_lots_consumed: rawLots,
        finished_goods_batch: fgBatch || null,
        finished_goods_batches: fgBatch ? [fgBatch] : [],
        dispatch: dispatchDelivery
          ? {
              delivery_number: dispatchDelivery.delivery_number,
              destination_address: dispatchDelivery.destination_address,
              vehicle_number: dispatchDelivery.vehicle_number || 'Pending vehicle dispatch',
              status: dispatchDelivery.status,
              dispatch_date: dispatchDelivery.dispatch_date,
            }
          : null,
      };

      return res.json({
        success: true,
        traceability: record,
        records: [record],
        availableBatches: batches.map((b: any) => b.batch_number),
      });
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

    if (queryTerm) {
      query = query.ilike('batch_number', `%${queryTerm}%`);
    }

    const { data: records, error } = await query;
    if (error) throw error;

    const first = records?.[0] || null;
    return res.json({
      success: true,
      traceability: first,
      records: records || [],
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
