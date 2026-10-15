import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { z } from 'zod';
import crypto from 'crypto';

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

// List Customer Orders
export const getOrders = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    if (!isSupabaseConfigured) {
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

        const finalSellingPrice = orderSellingPrice || enrichedItems[0]?.selling_price_per_kg || 0;
        const finalRecipeCost = orderRecipeCost || enrichedItems[0]?.recipe_cost_per_kg || 0;
        const totalWeight = Number(o.total_requested_weight_kg || 0);

        return {
          ...o,
          grade: o.grade || parsedOrder.grade,
          size_micron: o.size_micron || parsedOrder.sizeMicron,
          selling_price_per_kg: finalSellingPrice,
          recipe_cost_per_kg: finalRecipeCost,
          total_order_value: Number((finalSellingPrice * totalWeight).toFixed(2)),
          total_estimated_cost: Number((finalRecipeCost * totalWeight).toFixed(2)),
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
          produced_quantity_kg, dispatched_quantity_kg, status, notes,
          products (id, code, name, unit)
        )
      `)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;

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
          grade: parsedItem.grade || parsedOrder.grade,
          size_micron: parsedItem.sizeMicron || parsedOrder.sizeMicron,
          selling_price_per_kg: itemSellingPrice,
          recipe_cost_per_kg: itemRecipeCost,
          notes: parsedItem.notes || it.notes,
        };
      });

      const finalSellingPrice = orderSellingPrice || items[0]?.selling_price_per_kg || 0;
      const finalRecipeCost = orderRecipeCost || items[0]?.recipe_cost_per_kg || 0;
      const totalWeight = Number(o.total_requested_weight_kg || 0);

      return {
        ...o,
        grade: parsedOrder.grade,
        size_micron: parsedOrder.sizeMicron,
        selling_price_per_kg: finalSellingPrice,
        recipe_cost_per_kg: finalRecipeCost,
        total_order_value: Number((finalSellingPrice * totalWeight).toFixed(2)),
        total_estimated_cost: Number((finalRecipeCost * totalWeight).toFixed(2)),
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
        selling_price_per_kg: orderSellingPrice,
        recipe_cost_per_kg: orderRecipeCost,
        total_order_value: Number((orderSellingPrice * totalWeight).toFixed(2)),
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
