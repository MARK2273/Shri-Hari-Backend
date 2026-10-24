import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { mockStore } from '../utils/mockStore';

const getTenantId = (req: Request): string =>
  (req.tenantId || process.env.DEFAULT_TENANT_SLUG || 'shri-hari-pack') as string;

// Full End-to-End Traceability (REP-07)
export const getTraceability = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { batchId, batchNumber, orderNumber, lotNumber, q } = req.query;
    const rawSearch = (batchId || batchNumber || orderNumber || lotNumber || q || '') as string;
    const queryTerm = rawSearch.trim().toLowerCase();

    if (!isSupabaseConfigured) {
      const batches = mockStore.productionBatches.filter((b: any) => b.tenant_id === tenantId);

      const availableBatches = batches.map((b: any) => {
        const prod = mockStore.products.find((p: any) => p.id === b.product_id) || b.products;
        const ord = mockStore.orders.find((o: any) => o.id === b.order_id || o.order_number === b.order_id);
        const cust = ord?.customer_id
          ? mockStore.customers.find((c: any) => c.id === ord.customer_id)
          : ord?.customers || b.customer_orders?.customers;
        return {
          id: b.id,
          batch_number: b.batch_number,
          product_name: prod?.name || b.product_name || 'Finished Product',
          customer_name: cust?.name || ord?.customer_name || 'Direct Customer',
          operator_name: b.operator_name || null,
          created_at: b.created_at || b.start_time || new Date().toISOString(),
          accepted_output_kg: b.accepted_output_kg || b.planned_quantity_kg || 0,
        };
      });

      // Search by batchId, batchNumber, product name, customer name, or operator
      let matchedBatch: any = null;
      if (batchId) {
        matchedBatch = batches.find((b: any) => b.id === batchId);
      } else if (batchNumber) {
        matchedBatch = batches.find((b: any) => b.batch_number?.toLowerCase() === (batchNumber as string).toLowerCase());
      } else if (queryTerm) {
        matchedBatch = batches.find((b: any) => {
          const prod = mockStore.products.find((p: any) => p.id === b.product_id) || b.products;
          const ord = mockStore.orders.find((o: any) => o.id === b.order_id);
          const cust = ord?.customer_id
            ? mockStore.customers.find((c: any) => c.id === ord.customer_id)
            : ord?.customers || b.customer_orders?.customers;
          const matchProd = (prod?.name || b.product_name || '').toLowerCase().includes(queryTerm);
          const matchCust = (cust?.name || ord?.customer_name || '').toLowerCase().includes(queryTerm);
          const matchOp = (b.operator_name || '').toLowerCase().includes(queryTerm);
          const matchBatch = b.batch_number?.toLowerCase().includes(queryTerm);
          const matchOrder = b.customer_orders?.order_number?.toLowerCase().includes(queryTerm);
          return matchProd || matchCust || matchOp || matchBatch || matchOrder;
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
          availableBatches,
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
        availableBatches,
      });
    }

    // In connected Supabase: query production batches
    const isUuid = (val?: string) =>
      Boolean(val && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val));

    let batchesListQuery = supabase
      .from('production_batches')
      .select(`
        id, batch_number, created_at, operator_name, planned_quantity_kg, accepted_output_kg,
        products (name),
        customer_orders (customers (name))
      `)
      .order('created_at', { ascending: false });

    if (isUuid(tenantId)) {
      batchesListQuery = batchesListQuery.eq('tenant_id', tenantId);
    }

    const { data: allBatches } = await batchesListQuery;

    const availableBatches = (allBatches || []).map((b: any) => ({
      id: b.id,
      batch_number: b.batch_number,
      product_name: b.products?.name || 'Finished Product',
      customer_name: b.customer_orders?.customers?.name || 'Direct Customer',
      operator_name: b.operator_name || null,
      created_at: b.created_at,
      accepted_output_kg: b.accepted_output_kg || b.planned_quantity_kg || 0,
    }));

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
      `);

    if (isUuid(tenantId)) {
      query = query.eq('tenant_id', tenantId);
    }

    if (batchId) {
      query = query.eq('id', batchId);
    } else if (batchNumber) {
      query = query.eq('batch_number', batchNumber);
    } else if (queryTerm) {
      const matched = availableBatches.find(
        (b: any) =>
          b.product_name.toLowerCase().includes(queryTerm) ||
          b.customer_name.toLowerCase().includes(queryTerm) ||
          (b.operator_name && b.operator_name.toLowerCase().includes(queryTerm)) ||
          b.batch_number.toLowerCase().includes(queryTerm)
      );
      if (matched) {
        query = query.eq('id', matched.id);
      } else {
        query = query.ilike('batch_number', `%${queryTerm}%`);
      }
    } else {
      query = query.order('created_at', { ascending: false }).limit(1);
    }

    const { data: records, error } = await query;
    if (error) throw error;

    const first = records?.[0] || null;

    if (!first) {
      return res.json({
        success: true,
        traceability: null,
        records: [],
        availableBatches,
      });
    }

    // Look up delivery dispatch note if order_id is present
    let dispatchDelivery: any = null;
    if (first.order_id) {
      const { data: delData } = await supabase
        .from('deliveries')
        .select('*')
        .eq('order_id', first.order_id)
        .limit(1);
      dispatchDelivery = delData?.[0] || null;
    }

    const totalInputKg =
      (first.production_material_consumption || []).reduce(
        (sum: number, c: any) => sum + (Number(c.actual_quantity_kg) || Number(c.planned_quantity_kg) || 0),
        0
      ) || Number(first.planned_quantity_kg || 1);

    const rawLots = (first.production_material_consumption || []).map((c: any) => {
      const actualKg = Number(c.actual_quantity_kg) || Number(c.planned_quantity_kg) || 0;
      return {
        material_name: c.materials?.name || 'Raw Polymer Material',
        supplier: c.material_batches?.supplier_lot_number
          ? `Supplier Lot: ${c.material_batches.supplier_lot_number}`
          : c.material_batches?.suppliers?.name || 'Approved Polymer Vendor',
        consumed_kg: actualKg,
        planned_kg: Number(c.planned_quantity_kg) || actualKg,
        contribution_pct: totalInputKg > 0 ? ((actualKg / totalInputKg) * 100).toFixed(1) : '0',
      };
    });

    const plannedKg = Number(first.planned_quantity_kg || 1);
    const acceptedKg = Number(first.accepted_output_kg || 0);
    const yieldPct = ((acceptedKg / plannedKg) * 100).toFixed(1);

    const enrichedRecord = {
      id: first.id,
      batch_number: first.batch_number,
      status: first.status,
      planned_quantity_kg: plannedKg,
      accepted_output_kg: acceptedKg,
      waste_kg: Number(first.waste_kg || 0),
      trim_waste_kg: Number(first.trim_waste_kg || 0),
      plant_waste_kg: Number(first.plant_waste_kg || 0),
      yield_percentage: yieldPct,
      start_time: first.start_time,
      operator_name: first.operator_name || null,
      customer_order: {
        id: first.customer_orders?.id,
        order_number: first.customer_orders?.order_number,
        customer_name: first.customer_orders?.customers?.name || 'Customer Account',
        delivery_address: first.customer_orders?.customers?.delivery_address || 'Shipping Address',
        status: first.customer_orders?.status || 'Confirmed',
        total_requested_weight_kg: plannedKg,
      },
      customer_orders: first.customer_orders,
      products: first.products,
      product_recipes: first.product_recipes || { version: 1 },
      production_batch: {
        id: first.id,
        batch_number: first.batch_number,
        operator_name: first.operator_name,
        status: first.status,
        yield_pct: yieldPct,
      },
      raw_material_lots_consumed: rawLots,
      finished_goods_batch: first.finished_goods_batches?.[0] || null,
      finished_goods_batches: first.finished_goods_batches || [],
      dispatch: dispatchDelivery
        ? {
            destination_address: dispatchDelivery.destination_address || first.customer_orders?.customers?.delivery_address,
            vehicle_number: dispatchDelivery.vehicle_number || 'Transport Vehicle',
            status: dispatchDelivery.status,
          }
        : null,
    };

    return res.json({
      success: true,
      traceability: enrichedRecord,
      records: [enrichedRecord],
      availableBatches,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
