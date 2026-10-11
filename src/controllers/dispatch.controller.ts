import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { z } from 'zod';
import { inMemOrders, inMemCustomers } from './orders.controller';
import { inMemProducts } from './products.controller';
import { inMemFGBatches } from './finishedGoods.controller';

export interface InMemDelivery {
  id: string;
  tenant_id: string;
  order_id: string;
  customer_id: string;
  delivery_number: string;
  destination_address: string;
  vehicle_number?: string;
  dispatch_date: string;
  status: string;
  notes?: string;
  customers?: any;
  customer_orders?: any;
  delivery_items?: any[];
}

import { mockStore, saveMockStore } from '../utils/mockStore';

export let inMemDeliveries: InMemDelivery[] = mockStore.deliveries;

const getTenantId = (req: Request): string =>
  (req.tenantId || process.env.DEFAULT_TENANT_SLUG || 'shri-hari-pack') as string;

// List deliveries / dispatches
export const getDeliveries = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    if (!isSupabaseConfigured) {
      const tenantDeliveries = inMemDeliveries.filter((d) => d.tenant_id === tenantId);
      const enriched = tenantDeliveries.map((d) => {
        const ord = inMemOrders.find((o) => o.id === d.order_id);
        const cust = inMemCustomers.find((c) => c.id === d.customer_id);
        return {
          ...d,
          customers: cust ? { id: cust.id, code: cust.code, name: cust.name, contact_person: cust.contact_person, phone: cust.phone } : null,
          customer_orders: ord ? { id: ord.id, order_number: ord.order_number } : null,
          delivery_items: d.delivery_items || [],
        };
      });
      return res.json({ success: true, deliveries: enriched });
    }

    const { data: deliveries, error } = await supabase
      .from('deliveries')
      .select(`
        *,
        customers (id, code, name, contact_person, phone),
        customer_orders (id, order_number),
        delivery_items (
          id, quantity_kg, notes,
          products (id, code, name, unit),
          delivery_batch_allocations (
            id, allocated_quantity_kg,
            finished_goods_batches (id, batch_number)
          )
        )
      `)
      .eq('tenant_id', tenantId)
      .order('dispatch_date', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, deliveries });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Create & Confirm Dispatch Note (DEL-01..DEL-06)
export const createAndConfirmDispatch = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = req.user?.id;

    const schema = z.object({
      orderId: z.string().min(1),
      deliveryNumber: z.string().optional(),
      destinationAddress: z.string().min(3),
      vehicleNumber: z.string().optional(),
      notes: z.string().optional(),
      items: z.array(z.object({
        orderItemId: z.string().min(1),
        productId: z.string().min(1),
        quantityKg: z.number().positive(),
        // Specific finished goods batch allocations for full traceability (FG-07)
        batchAllocations: z.array(z.object({
          finishedGoodsBatchId: z.string().min(1),
          quantityKg: z.number().positive()
        })).min(1)
      })).min(1)
    });

    const body = schema.parse(req.body);
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randSuffix = Math.floor(Math.random() * 900 + 100);
    const generatedDeliveryNum = body.deliveryNumber || `DEL-${dateStr}-${randSuffix}`;

    if (!isSupabaseConfigured) {
      const ord = inMemOrders.find((o) => o.id === body.orderId || o.order_number === body.orderId);
      const cust = ord?.customer_id ? inMemCustomers.find((c) => c.id === ord.customer_id) : null;

      // Deduct FG inventory & record
      for (const itm of body.items) {
        for (const alloc of itm.batchAllocations) {
          const fg = inMemFGBatches.find((b) => b.id === alloc.finishedGoodsBatchId);
          if (fg) {
            fg.quantity_on_hand_kg = Math.max(0, Number(fg.quantity_on_hand_kg) - alloc.quantityKg);
            fg.quantity_dispatched_kg = (fg.quantity_dispatched_kg || 0) + alloc.quantityKg;
            if (fg.quantity_on_hand_kg === 0) {
              fg.status = 'depleted';
            }
          }
        }

        if (ord) {
          const orderItem = ord.customer_order_items?.find((i) => i.id === itm.orderItemId) || ord.customer_order_items?.[0];
          if (orderItem) {
            orderItem.dispatched_quantity_kg = (orderItem.dispatched_quantity_kg || 0) + itm.quantityKg;
            if (orderItem.dispatched_quantity_kg >= orderItem.requested_quantity_kg) {
              orderItem.status = 'dispatched';
            }
          }
        }
      }

      if (ord) {
        const allDispatched = (ord.customer_order_items || []).every(
          (i) => (i.dispatched_quantity_kg || 0) >= i.requested_quantity_kg
        );
        if (allDispatched) {
          ord.status = 'dispatched';
        }
      }

      const newDelivery: InMemDelivery = {
        id: `del-${Date.now()}`,
        tenant_id: tenantId,
        order_id: ord?.id || body.orderId,
        customer_id: ord?.customer_id || '',
        delivery_number: generatedDeliveryNum,
        destination_address: body.destinationAddress,
        vehicle_number: body.vehicleNumber,
        dispatch_date: new Date().toISOString().split('T')[0],
        status: 'dispatched',
        notes: body.notes,
        customers: cust ? { id: cust.id, code: cust.code, name: cust.name, contact_person: cust.contact_person, phone: cust.phone } : null,
        customer_orders: ord ? { id: ord.id, order_number: ord.order_number } : null,
        delivery_items: body.items.map((i) => {
          const prod = inMemProducts.find((p) => p.id === i.productId);
          return {
            id: `di-${Date.now()}`,
            quantity_kg: i.quantityKg,
            products: prod ? { id: prod.id, code: prod.code, name: prod.name, unit: prod.unit } : null,
            delivery_batch_allocations: i.batchAllocations.map((a) => {
              const fg = inMemFGBatches.find((b) => b.id === a.finishedGoodsBatchId);
              return {
                id: `dba-${Date.now()}`,
                allocated_quantity_kg: a.quantityKg,
                finished_goods_batches: fg ? { id: fg.id, batch_number: fg.batch_number } : null,
              };
            }),
          };
        }),
      };

      inMemDeliveries.unshift(newDelivery);
      saveMockStore();

      return res.status(201).json({
        success: true,
        message: 'Dispatch note created and inventory deducted successfully!',
        delivery_number: generatedDeliveryNum,
        delivery: newDelivery,
      });
    }

    // 1. Fetch Order and Customer
    const { data: order, error: ordErr } = await supabase
      .from('customer_orders')
      .select('customer_id')
      .eq('id', body.orderId)
      .eq('tenant_id', tenantId)
      .single();

    if (ordErr || !order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // 2. Validate finished goods inventory availability before confirming (DEL-05)
    for (const item of body.items) {
      const allocatedTotal = item.batchAllocations.reduce((sum, b) => sum + b.quantityKg, 0);
      if (Math.abs(allocatedTotal - item.quantityKg) > 0.001) {
        return res.status(400).json({
          success: false,
          message: `Allocated batch quantities (${allocatedTotal} kg) must match item dispatch quantity (${item.quantityKg} kg).`
        });
      }

      for (const alloc of item.batchAllocations) {
        const { data: fgBatch, error: fgErr } = await supabase
          .from('finished_goods_batches')
          .select('id, batch_number, quantity_on_hand_kg')
          .eq('id', alloc.finishedGoodsBatchId)
          .eq('tenant_id', tenantId)
          .single();

        if (fgErr || !fgBatch) {
          return res.status(400).json({ success: false, message: `Finished goods batch ID '${alloc.finishedGoodsBatchId}' not found.` });
        }

        if (Number(fgBatch.quantity_on_hand_kg) < alloc.quantityKg) {
          return res.status(400).json({
            success: false,
            message: `Insufficient finished stock in batch '${fgBatch.batch_number}'. Available: ${fgBatch.quantity_on_hand_kg} kg, Required: ${alloc.quantityKg} kg.`
          });
        }
      }
    }

    // 3. Create Delivery Header
    const { data: delivery, error: delErr } = await supabase
      .from('deliveries')
      .insert({
        tenant_id: tenantId,
        customer_id: order.customer_id,
        order_id: body.orderId,
        delivery_number: generatedDeliveryNum,
        destination_address: body.destinationAddress,
        vehicle_number: body.vehicleNumber,
        status: 'confirmed', // Stock is deducted upon confirmation (DEL-06)
        responsible_employee_id: userId,
        confirmed_by: userId,
        confirmed_at: new Date().toISOString(),
        notes: body.notes
      })
      .select('*')
      .single();

    if (delErr) throw delErr;

    // 4. Process each dispatch item and deduct stock
    for (const item of body.items) {
      const { data: delItem, error: diErr } = await supabase
        .from('delivery_items')
        .insert({
          delivery_id: delivery.id,
          order_item_id: item.orderItemId,
          product_id: item.productId,
          quantity_kg: item.quantityKg
        })
        .select('*')
        .single();

      if (diErr) throw diErr;

      // Process batch allocations
      for (const alloc of item.batchAllocations) {
        // Record allocation
        await supabase.from('delivery_batch_allocations').insert({
          delivery_item_id: delItem.id,
          finished_goods_batch_id: alloc.finishedGoodsBatchId,
          allocated_quantity_kg: alloc.quantityKg
        });

        // Deduct from Finished Goods batch
        const { data: currentFG } = await supabase
          .from('finished_goods_batches')
          .select('quantity_on_hand_kg, quantity_dispatched_kg')
          .eq('id', alloc.finishedGoodsBatchId)
          .single();

        const newOnHand = Number(currentFG?.quantity_on_hand_kg) - alloc.quantityKg;
        const newDispatched = Number(currentFG?.quantity_dispatched_kg || 0) + alloc.quantityKg;
        const status = newOnHand === 0 ? 'depleted' : 'partially_dispatched';

        await supabase
          .from('finished_goods_batches')
          .update({
            quantity_on_hand_kg: newOnHand,
            quantity_dispatched_kg: newDispatched,
            status,
            updated_at: new Date().toISOString()
          })
          .eq('id', alloc.finishedGoodsBatchId);

        // Append to inventory ledger
        await supabase.from('inventory_transactions').insert({
          tenant_id: tenantId,
          transaction_type: 'dispatch',
          item_type: 'finished_goods',
          product_id: item.productId,
          finished_goods_batch_id: alloc.finishedGoodsBatchId,
          quantity_kg: -alloc.quantityKg,
          reference_type: 'delivery',
          reference_id: delivery.id,
          reason: `Dispatched in ${delivery.delivery_number}`,
          created_by: userId
        });
      }

      // Update Order Item dispatched quantity
      const { data: orderItem } = await supabase
        .from('customer_order_items')
        .select('dispatched_quantity_kg, requested_quantity_kg')
        .eq('id', item.orderItemId)
        .single();

      const newDispatchedItemQty = Number(orderItem?.dispatched_quantity_kg || 0) + item.quantityKg;
      const isItemFullyDispatched = newDispatchedItemQty >= Number(orderItem?.requested_quantity_kg);

      await supabase
        .from('customer_order_items')
        .update({
          dispatched_quantity_kg: newDispatchedItemQty,
          status: isItemFullyDispatched ? 'dispatched' : 'partially_dispatched'
        })
        .eq('id', item.orderItemId);
    }

    // Check if entire order is fully dispatched
    const { data: allOrderItems } = await supabase
      .from('customer_order_items')
      .select('dispatched_quantity_kg, requested_quantity_kg')
      .eq('order_id', body.orderId);

    const allDispatched = (allOrderItems || []).every((i: any) => Number(i.dispatched_quantity_kg) >= Number(i.requested_quantity_kg));
    await supabase
      .from('customer_orders')
      .update({
        status: allDispatched ? 'completed' : 'partially_dispatched',
        updated_at: new Date().toISOString()
      })
      .eq('id', body.orderId);

    // Audit log
    await supabase.from('audit_logs').insert({
      tenant_id: tenantId,
      user_id: userId,
      action: 'CONFIRM_DISPATCH',
      entity_name: 'deliveries',
      entity_id: delivery.id,
      new_values: { delivery_number: body.deliveryNumber, items: body.items }
    });

    return res.status(201).json({
      success: true,
      message: 'Dispatch confirmed and finished goods stock deducted successfully.',
      delivery
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};
