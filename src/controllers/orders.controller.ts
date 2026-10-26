import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { z } from 'zod';
import crypto from 'crypto';
import { checkProductMaterialStock } from './products.controller';

interface InMemCustomer {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  contact_person?: string;
  phone?: string;
  email?: string;
  billing_address?: string;
  delivery_address?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface InMemOrderItem {
  id: string;
  order_id: string;
  product_id: string;
  requested_quantity_kg: number;
  planned_quantity_kg: number;
  produced_quantity_kg: number;
  dispatched_quantity_kg: number;
  status: string;
  notes?: string;
  grade?: string;
  size_micron?: string;
  selling_price_per_kg?: number;
  recipe_cost_per_kg?: number;
}

interface InMemOrder {
  id: string;
  tenant_id: string;
  customer_id: string;
  order_number: string;
  order_date: string;
  required_delivery_date: string;
  status: string;
  total_requested_weight_kg: number;
  notes?: string;
  grade?: string;
  size_micron?: string;
  selling_price_per_kg?: number;
  recipe_cost_per_kg?: number;
  total_order_value?: number;
  created_by?: string;
  created_at: string;
  customer_order_items: InMemOrderItem[];
}

export function formatOrderNotes(
  notes?: string,
  grade?: string,
  sizeMicron?: string,
  sellingPricePerKg?: number,
  recipeCostPerKg?: number
): string {
  const meta: {
    grade?: string;
    sizeMicron?: string;
    notes?: string;
    sellingPricePerKg?: number;
    recipeCostPerKg?: number;
  } = {};
  if (grade?.trim()) meta.grade = grade.trim();
  if (sizeMicron?.trim()) meta.sizeMicron = sizeMicron.trim();
  if (notes?.trim()) meta.notes = notes.trim();
  if (sellingPricePerKg !== undefined && Number(sellingPricePerKg) > 0) {
    meta.sellingPricePerKg = Number(sellingPricePerKg);
  }
  if (recipeCostPerKg !== undefined && Number(recipeCostPerKg) > 0) {
    meta.recipeCostPerKg = Number(recipeCostPerKg);
  }

  if (!meta.grade && !meta.sizeMicron && !meta.sellingPricePerKg && !meta.recipeCostPerKg) {
    return notes?.trim() || '';
  }
  return JSON.stringify(meta);
}

export function parseOrderNotes(rawNotes?: string | null): {
  notes: string;
  grade: string;
  sizeMicron: string;
  sellingPricePerKg: number;
  recipeCostPerKg: number;
} {
  if (!rawNotes) return { notes: '', grade: '', sizeMicron: '', sellingPricePerKg: 0, recipeCostPerKg: 0 };
  try {
    if (rawNotes.trim().startsWith('{')) {
      const parsed = JSON.parse(rawNotes);
      return {
        notes: parsed.notes || '',
        grade: parsed.grade || '',
        sizeMicron: parsed.sizeMicron || parsed.size_micron || '',
        sellingPricePerKg: Number(parsed.sellingPricePerKg || parsed.selling_price_per_kg || 0),
        recipeCostPerKg: Number(parsed.recipeCostPerKg || parsed.recipe_cost_per_kg || 0),
      };
    }
  } catch (e) {
    // Ignore JSON parse failure and fallback to string matching
  }

  const gradeMatch = rawNotes.match(/Grade:\s*([^|\n]+)/i);
  const sizeMatch = rawNotes.match(/(?:Size(?:\s*\/|\s+Micron)?|Micron):\s*([^|\n]+)/i);
  const sellMatch = rawNotes.match(/(?:Selling\s*Price|Rate):\s*₹?\s*([\d.]+)/i);
  const costMatch = rawNotes.match(/(?:Cost\s*Price|Recipe\s*Cost):\s*₹?\s*([\d.]+)/i);

  return {
    notes: rawNotes,
    grade: gradeMatch ? gradeMatch[1].trim() : '',
    sizeMicron: sizeMatch ? sizeMatch[1].trim() : '',
    sellingPricePerKg: sellMatch ? parseFloat(sellMatch[1]) : 0,
    recipeCostPerKg: costMatch ? parseFloat(costMatch[1]) : 0,
  };
}

import { mockStore, saveMockStore } from '../utils/mockStore';

export let inMemCustomers: InMemCustomer[] = mockStore.customers;
export let inMemOrders: InMemOrder[] = mockStore.orders;

const getTenantId = (req: Request): string => (req.tenantId || process.env.DEFAULT_TENANT_SLUG || 'shri-hari-pack') as string;

// Helper to determine if an order is currently in the production run
export const checkIsOrderInProductionRun = async (
  orderId: string,
  tenantId: string
): Promise<{ inProduction: boolean; reason?: string; batchNumber?: string }> => {
  const productionStatuses = [
    'in_production',
    'partially_produced',
    'produced',
    'completed',
    'partially_dispatched',
    'dispatched',
  ];

  if (!isSupabaseConfigured) {
    const order = inMemOrders.find((o) => o.id === orderId && o.tenant_id === tenantId);
    if (!order) return { inProduction: false };

    // 1. Status check on order
    if (productionStatuses.includes(order.status)) {
      return {
        inProduction: true,
        reason: `Order status is "${order.status.replace(/_/g, ' ')}"`,
      };
    }

    // 2. Production batches check in mockStore
    const batches = (mockStore.productionBatches || []).filter(
      (b: any) =>
        b.tenant_id === tenantId &&
        (b.order_id === orderId || (b.slitting_plan || []).some((sp: any) => sp.orderId === orderId)) &&
        b.status !== 'cancelled'
    );
    if (batches.length > 0) {
      return {
        inProduction: true,
        reason: `Production batch ${batches[0].batch_number} is currently ${batches[0].status.replace(/_/g, ' ')}`,
        batchNumber: batches[0].batch_number,
      };
    }

    // 3. Produced quantity check on items
    const hasProducedItem = (order.customer_order_items || []).some(
      (i) => Number(i.produced_quantity_kg || 0) > 0 || ['in_production', 'produced', 'dispatched'].includes(i.status)
    );
    if (hasProducedItem) {
      return {
        inProduction: true,
        reason: 'One or more recipe line items have already commenced production',
      };
    }

    return { inProduction: false };
  }

  // Supabase implementation
  const { data: order, error: ordErr } = await supabase
    .from('customer_orders')
    .select('id, order_number, status, customer_order_items(id, status, produced_quantity_kg)')
    .eq('id', orderId)
    .single();

  if (ordErr || !order) return { inProduction: false };

  if (productionStatuses.includes(order.status)) {
    return {
      inProduction: true,
      reason: `Order status is "${order.status.replace(/_/g, ' ')}"`,
    };
  }

  const { data: batches } = await supabase
    .from('production_batches')
    .select('id, batch_number, status')
    .eq('tenant_id', tenantId)
    .eq('order_id', orderId)
    .neq('status', 'cancelled');

  if (batches && batches.length > 0) {
    return {
      inProduction: true,
      reason: `Production batch ${batches[0].batch_number} is currently ${batches[0].status.replace(/_/g, ' ')}`,
      batchNumber: batches[0].batch_number,
    };
  }

  const hasProduced = (order.customer_order_items || []).some(
    (i: any) => Number(i.produced_quantity_kg || 0) > 0 || ['in_production', 'produced', 'dispatched'].includes(i.status)
  );
  if (hasProduced) {
    return {
      inProduction: true,
      reason: 'One or more recipe line items have already commenced production',
    };
  }

  return { inProduction: false };
};

// List Customer Orders
export const getOrders = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    if (!isSupabaseConfigured) {
      const activeBatches = (mockStore.productionBatches || []).filter(
        (b: any) => b.tenant_id === tenantId && b.status !== 'cancelled'
      );
      const productionStatuses = [
        'in_production',
        'partially_produced',
        'produced',
        'completed',
        'partially_dispatched',
        'dispatched',
      ];

      const tenantOrders = inMemOrders.filter((o) => o.tenant_id === tenantId);
      const enriched = tenantOrders.map((o) => {
        const cust = inMemCustomers.find((c) => c.id === o.customer_id);
        const parsedOrder = parseOrderNotes(o.notes);
        const orderSellingPrice = o.selling_price_per_kg || parsedOrder.sellingPricePerKg || 0;
        const orderRecipeCost = o.recipe_cost_per_kg || parsedOrder.recipeCostPerKg || 0;

        const enrichedItems = (o.customer_order_items || []).map((it) => {
          const prod = mockStore.products?.find((p) => p.id === it.product_id);
          const parsedItem = parseOrderNotes(it.notes);
          const itemSellingPrice = it.selling_price_per_kg || parsedItem.sellingPricePerKg || orderSellingPrice || 0;
          const itemRecipeCost = it.recipe_cost_per_kg || parsedItem.recipeCostPerKg || orderRecipeCost || 0;
          return {
            ...it,
            grade: it.grade || parsedItem.grade || o.grade || parsedOrder.grade,
            size_micron: it.size_micron || parsedItem.sizeMicron || o.size_micron || parsedOrder.sizeMicron,
            selling_price_per_kg: itemSellingPrice,
            recipe_cost_per_kg: itemRecipeCost,
            notes: parsedItem.notes || it.notes,
            products: prod ? { id: prod.id, code: prod.code, name: prod.name, unit: prod.unit } : null,
          };
        });

        const totalOrderValue = enrichedItems.reduce((sum: number, it: any) => {
          return sum + (Number(it.requested_quantity_kg || 0) * Number(it.selling_price_per_kg || 0));
        }, 0);
        const totalEstimatedCost = enrichedItems.reduce((sum: number, it: any) => {
          return sum + (Number(it.requested_quantity_kg || 0) * Number(it.recipe_cost_per_kg || 0));
        }, 0);
        const totalWeight = enrichedItems.reduce((sum: number, it: any) => sum + Number(it.requested_quantity_kg || 0), 0) || Number(o.total_requested_weight_kg || 0);
        const finalSellingPrice = orderSellingPrice || (totalWeight > 0 ? totalOrderValue / totalWeight : 0) || enrichedItems[0]?.selling_price_per_kg || 0;
        const finalRecipeCost = orderRecipeCost || (totalWeight > 0 ? totalEstimatedCost / totalWeight : 0) || enrichedItems[0]?.recipe_cost_per_kg || 0;

        const orderBatches = activeBatches.filter(
          (b: any) => b.order_id === o.id || (b.slitting_plan || []).some((sp: any) => sp.orderId === o.id)
        );
        const hasProducedItem = enrichedItems.some(
          (it: any) => Number(it.produced_quantity_kg || 0) > 0 || ['in_production', 'produced', 'dispatched'].includes(it.status)
        );
        const inProd = productionStatuses.includes(o.status) || orderBatches.length > 0 || hasProducedItem;

        return {
          ...o,
          is_in_production_run: inProd,
          active_production_batches_count: orderBatches.length,
          grade: o.grade || parsedOrder.grade || enrichedItems[0]?.grade,
          size_micron: o.size_micron || parsedOrder.sizeMicron || enrichedItems[0]?.size_micron,
          selling_price_per_kg: Number(finalSellingPrice.toFixed(2)),
          recipe_cost_per_kg: Number(finalRecipeCost.toFixed(2)),
          total_order_value: Number(totalOrderValue.toFixed(2)),
          total_estimated_cost: Number(totalEstimatedCost.toFixed(2)),
          total_requested_weight_kg: totalWeight,
          notes: parsedOrder.notes || o.notes,
          customers: cust
            ? {
                id: cust.id,
                code: cust.code,
                name: cust.name,
                contact_person: cust.contact_person,
                phone: cust.phone,
                delivery_address: cust.delivery_address,
              }
            : null,
          customer_order_items: enrichedItems,
        };
      });
      return res.json({ success: true, orders: enriched });
    }

    const { data: orders, error } = await supabase
      .from('customer_orders')
      .select(`
        *,
        customers (id, code, name, contact_person, phone, delivery_address),
        customer_order_items (
          id, product_id, requested_quantity_kg, planned_quantity_kg,
          produced_quantity_kg, dispatched_quantity_kg, status, notes, size_micron, grade,
          products (id, code, name, unit)
        )
      `)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const { data: allActiveBatches } = await supabase
      .from('production_batches')
      .select('id, order_id, batch_number, status')
      .eq('tenant_id', tenantId)
      .neq('status', 'cancelled');

    const productionStatuses = [
      'in_production',
      'partially_produced',
      'produced',
      'completed',
      'partially_dispatched',
      'dispatched',
    ];

    const enrichedSupabaseOrders = (orders || []).map((o: any) => {
      const parsedOrder = parseOrderNotes(o.notes);
      const orderSellingPrice = parsedOrder.sellingPricePerKg || 0;
      const orderRecipeCost = parsedOrder.recipeCostPerKg || 0;

      const items = (o.customer_order_items || []).map((it: any) => {
        const parsedItem = parseOrderNotes(it.notes);
        const itemSellingPrice = parsedItem.sellingPricePerKg || orderSellingPrice || 0;
        const itemRecipeCost = parsedItem.recipeCostPerKg || orderRecipeCost || 0;
        return {
          ...it,
          grade: it.grade || parsedItem.grade || parsedOrder.grade,
          size_micron: it.size_micron || parsedItem.sizeMicron || parsedOrder.sizeMicron,
          selling_price_per_kg: itemSellingPrice,
          recipe_cost_per_kg: itemRecipeCost,
          notes: parsedItem.notes || it.notes,
        };
      });

      const totalOrderValue = items.reduce((sum: number, it: any) => {
        return sum + (Number(it.requested_quantity_kg || 0) * Number(it.selling_price_per_kg || 0));
      }, 0);
      const totalEstimatedCost = items.reduce((sum: number, it: any) => {
        return sum + (Number(it.requested_quantity_kg || 0) * Number(it.recipe_cost_per_kg || 0));
      }, 0);
      const totalWeight = items.reduce((sum: number, it: any) => sum + Number(it.requested_quantity_kg || 0), 0) || Number(o.total_requested_weight_kg || 0);
      const finalSellingPrice = orderSellingPrice || (totalWeight > 0 ? totalOrderValue / totalWeight : 0) || items[0]?.selling_price_per_kg || 0;
      const finalRecipeCost = orderRecipeCost || (totalWeight > 0 ? totalEstimatedCost / totalWeight : 0) || items[0]?.recipe_cost_per_kg || 0;

      const orderBatches = (allActiveBatches || []).filter((b: any) => b.order_id === o.id);
      const hasProducedItem = items.some(
        (it: any) => Number(it.produced_quantity_kg || 0) > 0 || ['in_production', 'produced', 'dispatched'].includes(it.status)
      );
      const inProd = productionStatuses.includes(o.status) || orderBatches.length > 0 || hasProducedItem;

      return {
        ...o,
        is_in_production_run: inProd,
        active_production_batches_count: orderBatches.length,
        grade: o.grade || parsedOrder.grade || items[0]?.grade,
        size_micron: o.size_micron || parsedOrder.sizeMicron || items[0]?.size_micron,
        selling_price_per_kg: Number(finalSellingPrice.toFixed(2)),
        recipe_cost_per_kg: Number(finalRecipeCost.toFixed(2)),
        total_order_value: Number(totalOrderValue.toFixed(2)),
        total_estimated_cost: Number(totalEstimatedCost.toFixed(2)),
        total_requested_weight_kg: totalWeight,
        notes: parsedOrder.notes || o.notes,
        customer_order_items: items,
      };
    });

    return res.json({ success: true, orders: enrichedSupabaseOrders });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Create new customer order (ORD-02, ORD-03)
export const createOrder = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = req.user?.id;

    const schema = z.object({
      customerId: z.string().min(1),
      orderNumber: z.string().optional(),
      requiredDeliveryDate: z.string(),
      grade: z.string().optional(),
      sizeMicron: z.string().optional(),
      sellingPricePerKg: z.number().positive().optional(),
      recipeCostPerKg: z.number().nonnegative().optional(),
      notes: z.string().optional(),
      items: z
        .array(
          z.object({
            productId: z.string().min(1),
            requestedQuantityKg: z.number().positive(),
            sellingPricePerKg: z.number().positive().optional(),
            recipeCostPerKg: z.number().nonnegative().optional(),
            grade: z.string().optional(),
            sizeMicron: z.string().optional(),
            notes: z.string().optional(),
          })
        )
        .min(1),
    });

    const body = schema.parse(req.body);
    const resolvedOrderNumber = body.orderNumber?.trim() || `ORD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 900 + 100)}`;
    const totalWeight = body.items.reduce((sum, item) => sum + item.requestedQuantityKg, 0);
    const orderGrade = body.grade?.trim() || body.items[0]?.grade?.trim() || '';
    const orderSizeMicron = body.sizeMicron?.trim() || body.items[0]?.sizeMicron?.trim() || '';
    const orderSellingPrice = body.sellingPricePerKg || body.items[0]?.sellingPricePerKg || 0;
    const orderRecipeCost = body.recipeCostPerKg || body.items[0]?.recipeCostPerKg || 0;
    const formattedHeaderNotes = formatOrderNotes(body.notes, orderGrade, orderSizeMicron, orderSellingPrice, orderRecipeCost);

    if (!isSupabaseConfigured) {
      const orderId = crypto.randomUUID();
      const orderItems: InMemOrderItem[] = body.items.map((it) => {
        const itemGrade = it.grade?.trim() || orderGrade;
        const itemSizeMicron = it.sizeMicron?.trim() || orderSizeMicron;
        const itemSelling = it.sellingPricePerKg || orderSellingPrice;
        const itemCost = it.recipeCostPerKg || orderRecipeCost;
        return {
          id: crypto.randomUUID(),
          order_id: orderId,
          product_id: it.productId,
          requested_quantity_kg: it.requestedQuantityKg,
          planned_quantity_kg: it.requestedQuantityKg,
          produced_quantity_kg: 0,
          dispatched_quantity_kg: 0,
          status: 'pending',
          grade: itemGrade,
          size_micron: itemSizeMicron,
          selling_price_per_kg: itemSelling,
          recipe_cost_per_kg: itemCost,
          notes: formatOrderNotes(it.notes || body.notes, itemGrade, itemSizeMicron, itemSelling, itemCost),
        };
      });

      const totalOrderValue = body.items.reduce(
        (sum, it) => sum + (it.requestedQuantityKg * (it.sellingPricePerKg || orderSellingPrice || 0)),
        0
      );
      const totalEstimatedCost = body.items.reduce(
        (sum, it) => sum + (it.requestedQuantityKg * (it.recipeCostPerKg || orderRecipeCost || 0)),
        0
      );

      const newOrder: InMemOrder = {
        id: orderId,
        tenant_id: tenantId,
        customer_id: body.customerId,
        order_number: resolvedOrderNumber,
        order_date: new Date().toISOString().split('T')[0],
        required_delivery_date: body.requiredDeliveryDate,
        status: 'confirmed',
        total_requested_weight_kg: totalWeight,
        grade: orderGrade,
        size_micron: orderSizeMicron,
        selling_price_per_kg: totalWeight > 0 ? Number((totalOrderValue / totalWeight).toFixed(2)) : orderSellingPrice,
        recipe_cost_per_kg: totalWeight > 0 ? Number((totalEstimatedCost / totalWeight).toFixed(2)) : orderRecipeCost,
        total_order_value: Number(totalOrderValue.toFixed(2)),
        notes: formattedHeaderNotes,
        created_by: userId,
        created_at: new Date().toISOString(),
        customer_order_items: orderItems,
      };

      inMemOrders.unshift(newOrder);
      saveMockStore();

      const cust = inMemCustomers.find((c) => c.id === body.customerId);
      return res.status(201).json({
        success: true,
        order: {
          ...newOrder,
          customers: cust || null,
        },
      });
    }

    // 1. Insert order header
    const { data: order, error: ordErr } = await supabase
      .from('customer_orders')
      .insert({
        tenant_id: tenantId,
        customer_id: body.customerId,
        order_number: resolvedOrderNumber,
        required_delivery_date: body.requiredDeliveryDate,
        total_requested_weight_kg: totalWeight,
        status: 'confirmed',
        notes: formattedHeaderNotes,
        created_by: userId,
      })
      .select('*')
      .single();

    if (ordErr) throw ordErr;

    // 2. Insert order items
    const itemsData = body.items.map((item) => {
      const itemGrade = item.grade?.trim() || orderGrade;
      const itemSizeMicron = item.sizeMicron?.trim() || orderSizeMicron;
      const itemSelling = item.sellingPricePerKg || orderSellingPrice;
      const itemCost = item.recipeCostPerKg || orderRecipeCost;
      return {
        order_id: order.id,
        product_id: item.productId,
        requested_quantity_kg: item.requestedQuantityKg,
        planned_quantity_kg: item.requestedQuantityKg,
        status: 'pending',
        size_micron: itemSizeMicron || null,
        grade: itemGrade || null,
        notes: formatOrderNotes(item.notes || body.notes, itemGrade, itemSizeMicron, itemSelling, itemCost),
      };
    });

    const { data: items, error: itemErr } = await supabase
      .from('customer_order_items')
      .insert(itemsData)
      .select('*');

    if (itemErr) throw itemErr;

    // 3. Log audit event
    await supabase.from('audit_logs').insert({
      tenant_id: tenantId,
      user_id: userId,
      action: 'CREATE_CUSTOMER_ORDER',
      entity_name: 'customer_orders',
      entity_id: order.id,
      new_values: { order, items },
    });

    return res.status(201).json({ success: true, order: { ...order, items } });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Customer management: Get list of customers
export const getCustomers = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    if (!isSupabaseConfigured) {
      const list = inMemCustomers.filter((c) => c.tenant_id === tenantId);
      return res.json({ success: true, customers: list });
    }

    const { data: customers, error } = await supabase
      .from('customers')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('name', { ascending: true });

    if (error) throw error;
    return res.json({ success: true, customers });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Customer management: Create Customer
export const createCustomer = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const schema = z.object({
      code: z.string().optional(),
      name: z.string().min(2),
      contactPerson: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().email().optional().or(z.literal('')),
      billingAddress: z.string().optional(),
      deliveryAddress: z.string().optional(),
    });

    const body = schema.parse(req.body);
    const codeUpper = body.code?.trim().toUpperCase() || `CUST-${Math.floor(Math.random() * 9000 + 1000)}`;

    if (!isSupabaseConfigured) {
      const exists = inMemCustomers.find(
        (c) => c.tenant_id === tenantId && c.code.toUpperCase() === codeUpper
      );
      if (exists) {
        return res.status(400).json({ success: false, message: `Customer with code '${codeUpper}' already exists.` });
      }

      const newCustomer: InMemCustomer = {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        code: codeUpper,
        name: body.name.trim(),
        contact_person: body.contactPerson?.trim() || '',
        phone: body.phone?.trim() || '',
        email: body.email?.trim() || '',
        billing_address: body.billingAddress?.trim() || '',
        delivery_address: body.deliveryAddress?.trim() || '',
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      inMemCustomers.push(newCustomer);
      saveMockStore();
      return res.status(201).json({ success: true, customer: newCustomer });
    }

    const { data: customer, error } = await supabase
      .from('customers')
      .insert({
        tenant_id: tenantId,
        code: codeUpper,
        name: body.name.trim(),
        contact_person: body.contactPerson,
        phone: body.phone,
        email: body.email || null,
        billing_address: body.billingAddress,
        delivery_address: body.deliveryAddress,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ success: false, message: `Customer code '${codeUpper}' already exists in this factory.` });
      }
      throw error;
    }
    return res.status(201).json({ success: true, customer });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Customer management: Update Customer Details
export const updateCustomer = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;

    const schema = z.object({
      name: z.string().min(2).optional(),
      contactPerson: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().email().optional().or(z.literal('')),
      billingAddress: z.string().optional(),
      deliveryAddress: z.string().optional(),
      isActive: z.boolean().optional(),
    });

    const body = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      const index = inMemCustomers.findIndex((c) => c.tenant_id === tenantId && c.id === id);
      if (index === -1) {
        return res.status(404).json({ success: false, message: 'Customer not found.' });
      }

      inMemCustomers[index] = {
        ...inMemCustomers[index],
        ...(body.name ? { name: body.name.trim() } : {}),
        ...(body.contactPerson !== undefined ? { contact_person: body.contactPerson.trim() } : {}),
        ...(body.phone !== undefined ? { phone: body.phone.trim() } : {}),
        ...(body.email !== undefined ? { email: body.email.trim() } : {}),
        ...(body.billingAddress !== undefined ? { billing_address: body.billingAddress.trim() } : {}),
        ...(body.deliveryAddress !== undefined ? { delivery_address: body.deliveryAddress.trim() } : {}),
        ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
        updated_at: new Date().toISOString(),
      };

      saveMockStore();

      return res.json({ success: true, customer: inMemCustomers[index] });
    }

    const updates: any = { updated_at: new Date().toISOString() };
    if (body.name) updates.name = body.name.trim();
    if (body.contactPerson !== undefined) updates.contact_person = body.contactPerson;
    if (body.phone !== undefined) updates.phone = body.phone;
    if (body.email !== undefined) updates.email = body.email || null;
    if (body.billingAddress !== undefined) updates.billing_address = body.billingAddress;
    if (body.deliveryAddress !== undefined) updates.delivery_address = body.deliveryAddress;
    if (body.isActive !== undefined) updates.is_active = body.isActive;

    const { data, error } = await supabase
      .from('customers')
      .update(updates)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ success: true, customer: data });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Customer management: Delete Customer
export const deleteCustomer = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!isSupabaseConfigured) {
      // Remove any linked orders in memory so user is never stuck
      mockStore.orders = mockStore.orders.filter((o) => o.customer_id !== id);
      mockStore.customers = mockStore.customers.filter((c) => c.id !== id);
      inMemOrders = mockStore.orders;
      inMemCustomers = mockStore.customers;
      saveMockStore();
      return res.json({ success: true, message: 'Customer deleted successfully.' });
    }

    // Supabase mode: delete linked items and orders if needed
    const { data: customerOrders } = await supabase
      .from('customer_orders')
      .select('id')
      .eq('customer_id', id);

    if (customerOrders && customerOrders.length > 0) {
      const orderIds = customerOrders.map((o: any) => o.id);
      await supabase.from('customer_order_items').delete().in('order_id', orderIds);
      await supabase.from('customer_orders').delete().eq('customer_id', id);
    }

    const { error: delErr } = await supabase
      .from('customers')
      .delete()
      .eq('id', id);

    if (delErr) throw delErr;
    return res.json({ success: true, message: 'Customer deleted successfully.' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Customer management: Seed Sample Packaging Customers
export const seedDefaultCustomers = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    const defaultCustomers = [
      {
        code: 'CUST-AMUL',
        name: 'Amul Dairy Foods Ltd.',
        contact_person: 'Vikram Mehta (Procurement Head)',
        phone: '+91 98765 11223',
        email: 'procurement@amul.coop',
        billing_address: 'Amul Dairy Road, Anand, Gujarat - 388001',
        delivery_address: 'Amul Central Packaging Depot, Plant #4, Anand, Gujarat',
      },
      {
        code: 'CUST-PARLE',
        name: 'Parle Products Pvt. Ltd.',
        contact_person: 'Anita Sharma (SCM Packaging)',
        phone: '+91 98234 55667',
        email: 'packaging.orders@parle.biz',
        billing_address: 'North Level Crossing, Vile Parle East, Mumbai - 400057',
        delivery_address: 'Parle Confectionery Unit, GIDC Estate, Ahmedabad',
      },
      {
        code: 'CUST-NESTLE',
        name: 'Nestlé India Ltd.',
        contact_person: 'Deepak Verma (Vendor Quality)',
        phone: '+91 99123 77889',
        email: 'vendorops@nestle.in',
        billing_address: 'Nestlé House, Jacaranda Marg, DLF Phase 2, Gurugram',
        delivery_address: 'Nestlé Moga Factory, GT Road, Moga, Punjab - 142001',
      },
      {
        code: 'CUST-HALD',
        name: 'Haldiram Snacks Mfg. Ltd.',
        contact_person: 'Sanjay Singhal (Store Manager)',
        phone: '+91 98111 88990',
        email: 'purchase@haldirams.com',
        billing_address: 'B-1/H-8, Mohan Co-op Industrial Estate, Mathura Road, New Delhi',
        delivery_address: 'Haldiram Mega Food Park, Sector 68, Noida, Uttar Pradesh',
      },
    ];

    if (!isSupabaseConfigured) {
      const added: InMemCustomer[] = [];
      for (const item of defaultCustomers) {
        const exists = inMemCustomers.find(
          (c) => c.tenant_id === tenantId && c.code.toUpperCase() === item.code
        );
        if (!exists) {
          const cust: InMemCustomer = {
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            ...item,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          inMemCustomers.push(cust);
          added.push(cust);
        }
      }
      return res.json({ success: true, message: `Configured ${added.length} sample enterprise clients.`, added });
    }

    const { data: existing } = await supabase
      .from('customers')
      .select('code')
      .eq('tenant_id', tenantId);

    const existingCodes = new Set((existing || []).map((e: any) => e.code));
    const toInsert = defaultCustomers
      .filter((c) => !existingCodes.has(c.code))
      .map((c) => ({
        tenant_id: tenantId,
        ...c,
      }));

    if (toInsert.length > 0) {
      const { data, error } = await supabase.from('customers').insert(toInsert).select('*');
      if (error) throw error;
      return res.json({ success: true, message: `Configured ${toInsert.length} clients.`, added: data });
    }

    return res.json({ success: true, message: 'All sample packaging clients already exist.', added: [] });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Increase customer order quantity if not in production run and raw materials are sufficient
export const increaseOrderQuantity = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = req.user?.id;
    const { id } = req.params;

    const schema = z.object({
      itemId: z.string().optional(),
      productId: z.string().optional(),
      recipeId: z.string().optional(),
      grade: z.string().optional(),
      sizeMicron: z.string().optional(),
      sellingPricePerKg: z.number().positive().optional(),
      increaseByKg: z.number().positive().optional(),
      newQuantityKg: z.number().positive().optional(),
      items: z
        .array(
          z.object({
            itemId: z.string().min(1),
            productId: z.string().optional(),
            recipeId: z.string().optional(),
            grade: z.string().optional(),
            sizeMicron: z.string().optional(),
            sellingPricePerKg: z.number().positive().optional(),
            increaseByKg: z.number().positive().optional(),
            newQuantityKg: z.number().positive().optional(),
          })
        )
        .optional(),
      reason: z.string().optional(),
    });

    const body = schema.parse(req.body);

    // 1. Strict check: Order MUST NOT be in the production run
    const prodCheck = await checkIsOrderInProductionRun(id, tenantId);
    if (prodCheck.inProduction) {
      return res.status(400).json({
        success: false,
        message: `Cannot increase order quantity: This order is already in the production run (${prodCheck.reason}). Quantities and formulations can only be increased before production starts.`,
      });
    }

    if (!isSupabaseConfigured) {
      const order = inMemOrders.find((o) => o.id === id);
      if (!order) {
        return res.status(404).json({ success: false, message: 'Customer order not found.' });
      }

      if (['completed', 'cancelled', 'delivered'].includes(order.status)) {
        return res.status(400).json({
          success: false,
          message: `Cannot increase order quantity because order is already ${order.status}.`,
        });
      }

      const totalRequested = (order.customer_order_items || []).reduce(
        (sum, it) => sum + Number(it.requested_quantity_kg || 0),
        0
      ) || Number(order.total_requested_weight_kg || 0);

      // Resolve items to update
      const itemsToUpdate: Array<{
        itemId: string;
        newKg: number;
        increaseKg: number;
        productId?: string;
        recipeId?: string;
        grade?: string;
        sizeMicron?: string;
        sellingPricePerKg?: number;
      }> = [];

      if (body.items && body.items.length > 0) {
        for (const itmReq of body.items) {
          const item = (order.customer_order_items || []).find((it) => it.id === itmReq.itemId);
          if (!item) {
            return res.status(404).json({ success: false, message: `Order item ${itmReq.itemId} not found.` });
          }
          const currentKg = Number(item.requested_quantity_kg || 0);
          let targetKg = currentKg;
          if (itmReq.newQuantityKg !== undefined) {
            targetKg = Number(itmReq.newQuantityKg);
          } else if (itmReq.increaseByKg !== undefined) {
            targetKg = currentKg + Number(itmReq.increaseByKg);
          }
          if (targetKg <= currentKg) {
            return res.status(400).json({
              success: false,
              message: `New quantity (${targetKg} kg) must be strictly greater than current quantity (${currentKg} kg).`,
            });
          }
          itemsToUpdate.push({
            itemId: item.id,
            newKg: targetKg,
            increaseKg: targetKg - currentKg,
            productId: itmReq.productId,
            recipeId: itmReq.recipeId,
            grade: itmReq.grade,
            sizeMicron: itmReq.sizeMicron,
            sellingPricePerKg: itmReq.sellingPricePerKg,
          });
        }
      } else {
        const item = body.itemId
          ? (order.customer_order_items || []).find((it) => it.id === body.itemId)
          : (order.customer_order_items && order.customer_order_items[0]);

        if (!item) {
          return res.status(404).json({ success: false, message: 'Order line item not found.' });
        }

        const currentKg = Number(item.requested_quantity_kg || 0);
        let targetKg = currentKg;
        if (body.newQuantityKg !== undefined) {
          targetKg = Number(body.newQuantityKg);
        } else if (body.increaseByKg !== undefined) {
          targetKg = currentKg + Number(body.increaseByKg);
        } else {
          return res.status(400).json({
            success: false,
            message: 'Please provide either increaseByKg or newQuantityKg.',
          });
        }

        if (targetKg <= currentKg) {
          return res.status(400).json({
            success: false,
            message: `New quantity (${targetKg} kg) must be strictly greater than current quantity (${currentKg} kg).`,
          });
        }
        itemsToUpdate.push({
          itemId: item.id,
          newKg: targetKg,
          increaseKg: targetKg - currentKg,
          productId: body.productId,
          recipeId: body.recipeId,
          grade: body.grade,
          sizeMicron: body.sizeMicron,
          sellingPricePerKg: body.sellingPricePerKg,
        });
      }

      // 2. Validate sufficient raw material stock for each increase
      for (const upd of itemsToUpdate) {
        const existingItem = order.customer_order_items.find((i) => i.id === upd.itemId);
        const targetProdId = upd.productId || existingItem?.product_id;
        const stockCheck = await checkProductMaterialStock(tenantId, targetProdId, upd.recipeId, upd.increaseKg);

        if (!stockCheck.sufficient) {
          return res.status(400).json({
            success: false,
            message: `Cannot increase order: Insufficient raw material inventory to produce additional ${upd.increaseKg} kg. ${stockCheck.missingDetails || ''}`,
            requirements: stockCheck.requirements,
          });
        }
      }

      // Apply updates to inMem
      for (const upd of itemsToUpdate) {
        const itm = order.customer_order_items.find((i) => i.id === upd.itemId);
        if (itm) {
          itm.requested_quantity_kg = upd.newKg;
          itm.planned_quantity_kg = Math.max(Number(itm.planned_quantity_kg || 0), upd.newKg);
          if (upd.productId) {
            itm.product_id = upd.productId;
            const p = mockStore.products?.find((prod) => prod.id === upd.productId);
            if (p) {
              const activeRec = p.product_recipes?.find((r: any) => r.is_active) || p.product_recipes?.[0];
              if (activeRec && p.recipe_cost_per_kg) {
                itm.recipe_cost_per_kg = p.recipe_cost_per_kg;
              }
            }
          }
          if (upd.grade !== undefined) itm.grade = upd.grade.trim();
          if (upd.sizeMicron !== undefined) itm.size_micron = upd.sizeMicron.trim();
          if (upd.sellingPricePerKg !== undefined && Number(upd.sellingPricePerKg) > 0) {
            itm.selling_price_per_kg = Number(upd.sellingPricePerKg);
          }
          itm.notes = formatOrderNotes(
            itm.notes,
            itm.grade,
            itm.size_micron,
            itm.selling_price_per_kg,
            itm.recipe_cost_per_kg
          );
        }
      }

      const newTotalWeight = order.customer_order_items.reduce(
        (sum, it) => sum + Number(it.requested_quantity_kg || 0),
        0
      );
      order.total_requested_weight_kg = newTotalWeight;

      // Recalculate total order value
      const totalOrderVal = order.customer_order_items.reduce(
        (sum, it) => sum + (Number(it.requested_quantity_kg || 0) * Number(it.selling_price_per_kg || order.selling_price_per_kg || 0)),
        0
      );
      if (totalOrderVal > 0) {
        order.total_order_value = Number(totalOrderVal.toFixed(2));
      }

      const reasonNote = body.reason?.trim() ? ` [Qty Increased: ${body.reason.trim()}]` : ` [Qty increased to ${newTotalWeight} kg]`;
      if (order.notes) {
        order.notes += reasonNote;
      } else {
        order.notes = reasonNote.trim();
      }

      saveMockStore();

      mockStore.auditLogs.unshift({
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        user_id: userId,
        action: 'INCREASE_ORDER_QUANTITY',
        entity_name: 'customer_orders',
        entity_id: order.id,
        new_values: { previousWeight: totalRequested, newWeight: newTotalWeight, updates: itemsToUpdate, reason: body.reason },
        created_at: new Date().toISOString(),
      });

      return res.json({
        success: true,
        message: `Order ${order.order_number} quantity successfully increased to ${newTotalWeight} kg.`,
        order,
      });
    }

    // Supabase implementation
    const { data: order, error: ordErr } = await supabase
      .from('customer_orders')
      .select(`
        *,
        customer_order_items (
          id, product_id, requested_quantity_kg, planned_quantity_kg,
          produced_quantity_kg, dispatched_quantity_kg, status, notes, size_micron, grade
        )
      `)
      .eq('id', id)
      .single();

    if (ordErr || !order) {
      console.error('[increaseOrderQuantity] Order fetch error:', ordErr);
      return res.status(404).json({ success: false, message: 'Customer order not found.' });
    }

    if (['completed', 'cancelled', 'delivered'].includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot increase order quantity because order is already ${order.status}.`,
      });
    }

    const orderItems: any[] = (order.customer_order_items || []).map((it: any) => {
      const parsed = parseOrderNotes(it.notes);
      return {
        ...it,
        grade: it.grade || parsed.grade,
        size_micron: it.size_micron || parsed.sizeMicron,
        selling_price_per_kg: parsed.sellingPricePerKg,
        recipe_cost_per_kg: parsed.recipeCostPerKg,
      };
    });

    const totalRequested = orderItems.reduce(
      (sum: number, it: any) => sum + Number(it.requested_quantity_kg || 0),
      0
    ) || Number(order.total_requested_weight_kg || 0);

    // Resolve items to update
    const itemsToUpdate: Array<{
      itemId: string;
      newKg: number;
      increaseKg: number;
      productId?: string;
      recipeId?: string;
      grade?: string;
      sizeMicron?: string;
      sellingPricePerKg?: number;
    }> = [];

    if (body.items && body.items.length > 0) {
      for (const itmReq of body.items) {
        const item = orderItems.find((it: any) => it.id === itmReq.itemId);
        if (!item) {
          return res.status(404).json({ success: false, message: `Order item ${itmReq.itemId} not found.` });
        }
        const currentKg = Number(item.requested_quantity_kg || 0);
        let targetKg = currentKg;
        if (itmReq.newQuantityKg !== undefined) {
          targetKg = Number(itmReq.newQuantityKg);
        } else if (itmReq.increaseByKg !== undefined) {
          targetKg = currentKg + Number(itmReq.increaseByKg);
        }
        if (targetKg <= currentKg) {
          return res.status(400).json({
            success: false,
            message: `New quantity (${targetKg} kg) must be strictly greater than current quantity (${currentKg} kg).`,
          });
        }
        itemsToUpdate.push({
          itemId: item.id,
          newKg: targetKg,
          increaseKg: targetKg - currentKg,
          productId: itmReq.productId,
          recipeId: itmReq.recipeId,
          grade: itmReq.grade,
          sizeMicron: itmReq.sizeMicron,
          sellingPricePerKg: itmReq.sellingPricePerKg,
        });
      }
    } else {
      const item = body.itemId
        ? orderItems.find((it: any) => it.id === body.itemId)
        : orderItems[0];

      if (!item) {
        return res.status(404).json({ success: false, message: 'Order line item not found.' });
      }

      const currentKg = Number(item.requested_quantity_kg || 0);
      let targetKg = currentKg;
      if (body.newQuantityKg !== undefined) {
        targetKg = Number(body.newQuantityKg);
      } else if (body.increaseByKg !== undefined) {
        targetKg = currentKg + Number(body.increaseByKg);
      } else {
        return res.status(400).json({
          success: false,
          message: 'Please provide either increaseByKg or newQuantityKg.',
        });
      }

      if (targetKg <= currentKg) {
        return res.status(400).json({
          success: false,
          message: `New quantity (${targetKg} kg) must be strictly greater than current quantity (${currentKg} kg).`,
        });
      }
      itemsToUpdate.push({
        itemId: item.id,
        newKg: targetKg,
        increaseKg: targetKg - currentKg,
        productId: body.productId,
        recipeId: body.recipeId,
        grade: body.grade,
        sizeMicron: body.sizeMicron,
        sellingPricePerKg: body.sellingPricePerKg,
      });
    }

    // 2. Stock check in Supabase
    for (const upd of itemsToUpdate) {
      const existingItem = orderItems.find((i: any) => i.id === upd.itemId);
      const targetProdId = upd.productId || existingItem?.product_id;
      const stockCheck = await checkProductMaterialStock(tenantId, targetProdId, upd.recipeId, upd.increaseKg);

      if (!stockCheck.sufficient) {
        return res.status(400).json({
          success: false,
          message: `Cannot increase order: Insufficient raw material inventory to produce additional ${upd.increaseKg} kg. ${stockCheck.missingDetails || ''}`,
          requirements: stockCheck.requirements,
        });
      }
    }

    // Update items in Supabase
    for (const upd of itemsToUpdate) {
      const itm = orderItems.find((i: any) => i.id === upd.itemId);
      const newPlanned = Math.max(Number(itm?.planned_quantity_kg || 0), upd.newKg);

      const itemUpdates: any = {
        requested_quantity_kg: upd.newKg,
        planned_quantity_kg: newPlanned,
      };

      if (upd.productId) itemUpdates.product_id = upd.productId;
      if (upd.grade !== undefined) itemUpdates.grade = upd.grade.trim() || null;
      if (upd.sizeMicron !== undefined) itemUpdates.size_micron = upd.sizeMicron.trim() || null;

      const newSellingPrice = upd.sellingPricePerKg !== undefined && Number(upd.sellingPricePerKg) > 0
        ? Number(upd.sellingPricePerKg)
        : (itm?.selling_price_per_kg || 0);

      const formattedNotes = formatOrderNotes(
        itm?.notes,
        itemUpdates.grade || itm?.grade,
        itemUpdates.size_micron || itm?.size_micron,
        newSellingPrice,
        itm?.recipe_cost_per_kg
      );
      itemUpdates.notes = formattedNotes;

      const { error: updErr } = await supabase
        .from('customer_order_items')
        .update(itemUpdates)
        .eq('id', upd.itemId);

      if (updErr) {
        console.error('[increaseOrderQuantity] Item update error:', updErr);
        throw updErr;
      }
    }

    // Compute new total weight
    const updatedOrderItems = orderItems.map((i: any) => {
      const match = itemsToUpdate.find((u) => u.itemId === i.id);
      return match ? { ...i, requested_quantity_kg: match.newKg } : i;
    });

    const newTotalWeight = updatedOrderItems.reduce(
      (sum: number, it: any) => sum + Number(it.requested_quantity_kg || 0),
      0
    );

    const parsedOrder = parseOrderNotes(order.notes);
    const reasonNote = body.reason?.trim() ? ` [Qty Increased: ${body.reason.trim()}]` : ` [Qty increased to ${newTotalWeight} kg]`;
    const updatedNotesText = parsedOrder.notes ? `${parsedOrder.notes}${reasonNote}` : reasonNote.trim();
    const formattedOrderNotes = formatOrderNotes(
      updatedNotesText,
      order.grade || parsedOrder.grade,
      order.size_micron || parsedOrder.sizeMicron,
      parsedOrder.sellingPricePerKg,
      parsedOrder.recipeCostPerKg
    );

    const { data: updatedOrder, error: orderUpdErr } = await supabase
      .from('customer_orders')
      .update({
        total_requested_weight_kg: newTotalWeight,
        notes: formattedOrderNotes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();

    if (orderUpdErr) {
      console.error('[increaseOrderQuantity] Order header update error:', orderUpdErr);
      throw orderUpdErr;
    }

    // Audit log
    await supabase.from('audit_logs').insert({
      tenant_id: order.tenant_id || tenantId,
      user_id: userId,
      action: 'INCREASE_ORDER_QUANTITY',
      entity_name: 'customer_orders',
      entity_id: id,
      new_values: { previousWeight: totalRequested, newWeight: newTotalWeight, updates: itemsToUpdate, reason: body.reason },
    });

    return res.json({
      success: true,
      message: `Order ${order.order_number} quantity successfully increased to ${newTotalWeight} kg.`,
      order: updatedOrder,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Update Customer Order & Recipe Items (only allowed when order is NOT in production run)
export const updateOrder = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = req.user?.id;
    const { id } = req.params;

    const schema = z.object({
      customerId: z.string().optional(),
      requiredDeliveryDate: z.string().optional(),
      grade: z.string().optional(),
      sizeMicron: z.string().optional(),
      sellingPricePerKg: z.number().positive().optional(),
      recipeCostPerKg: z.number().nonnegative().optional(),
      notes: z.string().optional(),
      items: z
        .array(
          z.object({
            id: z.string().optional(),
            productId: z.string().min(1),
            requestedQuantityKg: z.number().positive(),
            sellingPricePerKg: z.number().positive().optional(),
            recipeCostPerKg: z.number().nonnegative().optional(),
            grade: z.string().optional(),
            sizeMicron: z.string().optional(),
            notes: z.string().optional(),
          })
        )
        .min(1)
        .optional(),
    });

    const body = schema.parse(req.body);

    // 1. Strict check: Order MUST NOT be in the production run
    const prodCheck = await checkIsOrderInProductionRun(id, tenantId);
    if (prodCheck.inProduction) {
      return res.status(400).json({
        success: false,
        message: `Cannot update order: This order is already in the production run (${prodCheck.reason}). Orders and formulations cannot be modified once production has started.`,
      });
    }

    if (!isSupabaseConfigured) {
      const order = inMemOrders.find((o) => o.id === id && o.tenant_id === tenantId);
      if (!order) {
        return res.status(404).json({ success: false, message: 'Customer order not found.' });
      }

      if (['completed', 'cancelled', 'delivered'].includes(order.status)) {
        return res.status(400).json({
          success: false,
          message: `Cannot update order because it is already ${order.status}.`,
        });
      }

      // Check material availability for each updated item
      if (body.items && body.items.length > 0) {
        for (const itm of body.items) {
          const existingItem = (order.customer_order_items || []).find((i) => i.id === itm.id);
          const currentKg = Number(existingItem?.requested_quantity_kg || 0);
          const isSameProduct = existingItem && existingItem.product_id === itm.productId;
          const diffKg = isSameProduct ? Math.max(0, itm.requestedQuantityKg - currentKg) : itm.requestedQuantityKg;

          if (diffKg > 0) {
            const stockCheck = await checkProductMaterialStock(tenantId, itm.productId, undefined, diffKg);
            if (!stockCheck.sufficient) {
              const prod = mockStore.products?.find((p) => p.id === itm.productId);
              return res.status(400).json({
                success: false,
                message: `Cannot update order: Insufficient raw material inventory to produce ${diffKg} kg of ${prod?.name || 'formulation'}. ${stockCheck.missingDetails || ''}`,
                requirements: stockCheck.requirements,
              });
            }
          }
        }

        // Apply item updates
        const updatedItems: InMemOrderItem[] = body.items.map((it, idx) => {
          const existingItem = (order.customer_order_items || []).find((i) => i.id === it.id);
          const prod = mockStore.products?.find((p) => p.id === it.productId);
          const itemGrade = it.grade?.trim() || body.grade?.trim() || existingItem?.grade || '';
          const itemSize = it.sizeMicron?.trim() || body.sizeMicron?.trim() || existingItem?.size_micron || '';
          const itemSelling = it.sellingPricePerKg || body.sellingPricePerKg || existingItem?.selling_price_per_kg || 0;
          const itemCost = it.recipeCostPerKg || prod?.recipe_cost_per_kg || existingItem?.recipe_cost_per_kg || 0;

          return {
            id: it.id || existingItem?.id || crypto.randomUUID(),
            order_id: order.id,
            product_id: it.productId,
            requested_quantity_kg: it.requestedQuantityKg,
            planned_quantity_kg: it.requestedQuantityKg,
            produced_quantity_kg: existingItem?.produced_quantity_kg || 0,
            dispatched_quantity_kg: existingItem?.dispatched_quantity_kg || 0,
            status: existingItem?.status || 'pending',
            grade: itemGrade,
            size_micron: itemSize,
            selling_price_per_kg: itemSelling,
            recipe_cost_per_kg: itemCost,
            notes: formatOrderNotes(it.notes || existingItem?.notes || body.notes, itemGrade, itemSize, itemSelling, itemCost),
          };
        });

        order.customer_order_items = updatedItems;
      }

      if (body.customerId) order.customer_id = body.customerId;
      if (body.requiredDeliveryDate) order.required_delivery_date = body.requiredDeliveryDate;
      if (body.grade !== undefined) order.grade = body.grade.trim();
      if (body.sizeMicron !== undefined) order.size_micron = body.sizeMicron.trim();
      if (body.sellingPricePerKg !== undefined) order.selling_price_per_kg = body.sellingPricePerKg;

      const totalWeight = (order.customer_order_items || []).reduce(
        (sum, it) => sum + Number(it.requested_quantity_kg || 0),
        0
      );
      order.total_requested_weight_kg = totalWeight;

      const totalOrderVal = (order.customer_order_items || []).reduce(
        (sum, it) => sum + (Number(it.requested_quantity_kg || 0) * Number(it.selling_price_per_kg || order.selling_price_per_kg || 0)),
        0
      );
      order.total_order_value = Number(totalOrderVal.toFixed(2));

      if (body.notes !== undefined) {
        order.notes = formatOrderNotes(
          body.notes,
          order.grade,
          order.size_micron,
          order.selling_price_per_kg,
          order.recipe_cost_per_kg
        );
      }

      saveMockStore();

      mockStore.auditLogs.unshift({
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        user_id: userId,
        action: 'UPDATE_CUSTOMER_ORDER',
        entity_name: 'customer_orders',
        entity_id: order.id,
        new_values: body,
        created_at: new Date().toISOString(),
      });

      return res.json({
        success: true,
        message: `Order ${order.order_number} successfully updated.`,
        order,
      });
    }

    // Supabase implementation
    const { data: order, error: ordErr } = await supabase
      .from('customer_orders')
      .select(`
        *,
        customer_order_items (
          id, product_id, requested_quantity_kg, planned_quantity_kg,
          produced_quantity_kg, dispatched_quantity_kg, status, notes, size_micron, grade
        )
      `)
      .eq('id', id)
      .single();

    if (ordErr || !order) {
      console.error('[updateOrder] Order fetch error:', ordErr);
      return res.status(404).json({ success: false, message: 'Customer order not found.' });
    }

    if (['completed', 'cancelled', 'delivered'].includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot update order because it is already ${order.status}.`,
      });
    }

    const orderItems: any[] = (order.customer_order_items || []).map((it: any) => {
      const parsed = parseOrderNotes(it.notes);
      return {
        ...it,
        grade: it.grade || parsed.grade,
        size_micron: it.size_micron || parsed.sizeMicron,
        selling_price_per_kg: parsed.sellingPricePerKg,
        recipe_cost_per_kg: parsed.recipeCostPerKg,
      };
    });

    // Check material stock
    if (body.items && body.items.length > 0) {
      for (const itm of body.items) {
        const existingItem = orderItems.find((i: any) => i.id === itm.id);
        const currentKg = Number(existingItem?.requested_quantity_kg || 0);
        const isSameProduct = existingItem && existingItem.product_id === itm.productId;
        const diffKg = isSameProduct ? Math.max(0, itm.requestedQuantityKg - currentKg) : itm.requestedQuantityKg;

        if (diffKg > 0) {
          const stockCheck = await checkProductMaterialStock(tenantId, itm.productId, undefined, diffKg);
          if (!stockCheck.sufficient) {
            return res.status(400).json({
              success: false,
              message: `Cannot update order: Insufficient raw material inventory to produce ${diffKg} kg of product. ${stockCheck.missingDetails || ''}`,
              requirements: stockCheck.requirements,
            });
          }
        }
      }

      // Upsert items in Supabase
      const submittedIds = new Set(body.items.filter((i) => i.id).map((i) => i.id));
      const itemsToDelete = orderItems.filter((i: any) => !submittedIds.has(i.id));

      if (itemsToDelete.length > 0) {
        await supabase
          .from('customer_order_items')
          .delete()
          .in('id', itemsToDelete.map((i: any) => i.id));
      }

      for (const itm of body.items) {
        const existingItem = orderItems.find((i: any) => i.id === itm.id);
        const itemGrade = itm.grade?.trim() || body.grade?.trim() || existingItem?.grade || '';
        const itemSize = itm.sizeMicron?.trim() || body.sizeMicron?.trim() || existingItem?.size_micron || '';
        const itemSelling = itm.sellingPricePerKg || body.sellingPricePerKg || existingItem?.selling_price_per_kg || 0;
        const itemCost = itm.recipeCostPerKg || existingItem?.recipe_cost_per_kg || 0;

        const formattedNotes = formatOrderNotes(
          itm.notes || existingItem?.notes || body.notes,
          itemGrade,
          itemSize,
          itemSelling,
          itemCost
        );

        if (existingItem) {
          const { error: itemUpdErr } = await supabase
            .from('customer_order_items')
            .update({
              product_id: itm.productId,
              requested_quantity_kg: itm.requestedQuantityKg,
              planned_quantity_kg: itm.requestedQuantityKg,
              grade: itemGrade || null,
              size_micron: itemSize || null,
              notes: formattedNotes,
            })
            .eq('id', existingItem.id);
          if (itemUpdErr) {
            console.error('[updateOrder] Item update error:', itemUpdErr);
            throw itemUpdErr;
          }
        } else {
          const { error: itemInsErr } = await supabase
            .from('customer_order_items')
            .insert({
              order_id: id,
              product_id: itm.productId,
              requested_quantity_kg: itm.requestedQuantityKg,
              planned_quantity_kg: itm.requestedQuantityKg,
              produced_quantity_kg: 0,
              dispatched_quantity_kg: 0,
              status: 'pending',
              grade: itemGrade || null,
              size_micron: itemSize || null,
              notes: formattedNotes,
            });
          if (itemInsErr) {
            console.error('[updateOrder] Item insert error:', itemInsErr);
            throw itemInsErr;
          }
        }
      }
    }

    const orderUpdates: any = { updated_at: new Date().toISOString() };
    if (body.customerId) orderUpdates.customer_id = body.customerId;
    if (body.requiredDeliveryDate) orderUpdates.required_delivery_date = body.requiredDeliveryDate;
    if (body.grade !== undefined) orderUpdates.grade = body.grade.trim() || null;
    if (body.sizeMicron !== undefined) orderUpdates.size_micron = body.sizeMicron.trim() || null;

    if (body.items && body.items.length > 0) {
      const newTotalWeight = body.items.reduce((sum, it) => sum + it.requestedQuantityKg, 0);
      orderUpdates.total_requested_weight_kg = newTotalWeight;
    }

    const parsedOrder = parseOrderNotes(order.notes);
    const orderSellingPrice = body.sellingPricePerKg !== undefined
      ? body.sellingPricePerKg
      : parsedOrder.sellingPricePerKg;
    const orderRecipeCost = parsedOrder.recipeCostPerKg || 0;
    const orderNotesText = body.notes !== undefined ? body.notes : parsedOrder.notes;

    orderUpdates.notes = formatOrderNotes(
      orderNotesText,
      orderUpdates.grade || order.grade || parsedOrder.grade,
      orderUpdates.size_micron || order.size_micron || parsedOrder.sizeMicron,
      orderSellingPrice,
      orderRecipeCost
    );

    const { data: updatedOrder, error: upErr } = await supabase
      .from('customer_orders')
      .update(orderUpdates)
      .eq('id', id)
      .select('*')
      .single();

    if (upErr) {
      console.error('[updateOrder] Order header update error:', upErr);
      throw upErr;
    }

    // Audit log
    await supabase.from('audit_logs').insert({
      tenant_id: tenantId,
      user_id: userId,
      action: 'UPDATE_CUSTOMER_ORDER',
      entity_name: 'customer_orders',
      entity_id: id,
      new_values: body,
    });

    return res.json({
      success: true,
      message: `Order ${order.order_number} successfully updated.`,
      order: updatedOrder,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

