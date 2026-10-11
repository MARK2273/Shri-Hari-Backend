import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { z } from 'zod';

// List Customer Orders
export const getOrders = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;

    if (!isSupabaseConfigured) {
      return res.json({
        success: true,
        orders: [
          {
            id: 'ord-1',
            order_number: 'ORD-20261011-001',
            customer_name: 'Gujarat Cooperative Milk Federation (Amul)',
            order_date: '2026-10-11',
            required_delivery_date: '2026-10-18',
            status: 'confirmed',
            total_requested_weight_kg: 500.0,
            items: [
              {
                id: 'item-1',
                product_id: 'prd-1',
                product_code: 'PRD-MILK-POUCH-500ML',
                product_name: 'Multi-Layer Co-Extruded Milk Pouch Film 500ml',
                requested_quantity_kg: 500.0,
                produced_quantity_kg: 200.0,
                dispatched_quantity_kg: 0.0,
                status: 'in_production'
              }
            ]
          }
        ]
      });
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
    return res.json({ success: true, orders });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Create new customer order (ORD-02, ORD-03)
export const createOrder = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    const userId = req.user?.id;

    const schema = z.object({
      customerId: z.string().uuid(),
      orderNumber: z.string().min(3),
      requiredDeliveryDate: z.string(),
      notes: z.string().optional(),
      items: z.array(z.object({
        productId: z.string().uuid(),
        requestedQuantityKg: z.number().positive(),
        notes: z.string().optional()
      })).min(1)
    });

    const body = schema.parse(req.body);
    const totalWeight = body.items.reduce((sum, item) => sum + item.requestedQuantityKg, 0);

    if (!isSupabaseConfigured) {
      return res.status(201).json({
        success: true,
        order: {
          id: `ord-${Date.now()}`,
          order_number: body.orderNumber,
          customer_id: body.customerId,
          status: 'confirmed',
          total_requested_weight_kg: totalWeight,
          items: body.items
        }
      });
    }

    // 1. Insert order header
    const { data: order, error: ordErr } = await supabase
      .from('customer_orders')
      .insert({
        tenant_id: tenantId,
        customer_id: body.customerId,
        order_number: body.orderNumber,
        required_delivery_date: body.requiredDeliveryDate,
        total_requested_weight_kg: totalWeight,
        status: 'confirmed', // Confirmed so production can start (ORD-04)
        notes: body.notes,
        created_by: userId
      })
      .select('*')
      .single();

    if (ordErr) throw ordErr;

    // 2. Insert order items
    const itemsData = body.items.map(item => ({
      order_id: order.id,
      product_id: item.productId,
      requested_quantity_kg: item.requestedQuantityKg,
      planned_quantity_kg: item.requestedQuantityKg,
      status: 'pending',
      notes: item.notes
    }));

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
      new_values: { order, items }
    });

    return res.status(201).json({ success: true, order: { ...order, items } });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Customer management helpers
export const getCustomers = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;

    if (!isSupabaseConfigured) {
      return res.json({
        success: true,
        customers: [
          { id: 'cust-1', code: 'CUST-AMUL-01', name: 'Gujarat Cooperative Milk Federation (Amul)', contact_person: 'Prakash Jha', phone: '+91 2692 258506', email: 'procurement@amul.coop' },
          { id: 'cust-2', code: 'CUST-PARLE-02', name: 'Parle Agro Products Pvt Ltd', contact_person: 'Ramesh Rao', phone: '+91 22 6734 8000', email: 'materials@parleagro.com' }
        ]
      });
    }

    const { data: customers, error } = await supabase
      .from('customers')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (error) throw error;
    return res.json({ success: true, customers });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createCustomer = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    const schema = z.object({
      code: z.string().min(2),
      name: z.string().min(2),
      contactPerson: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().email().optional(),
      billingAddress: z.string().optional(),
      deliveryAddress: z.string().optional()
    });

    const body = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      return res.status(201).json({ success: true, customer: { id: `cust-${Date.now()}`, ...body } });
    }

    const { data: customer, error } = await supabase
      .from('customers')
      .insert({
        tenant_id: tenantId,
        code: body.code.toUpperCase(),
        name: body.name,
        contact_person: body.contactPerson,
        phone: body.phone,
        email: body.email,
        billing_address: body.billingAddress,
        delivery_address: body.deliveryAddress
      })
      .select('*')
      .single();

    if (error) throw error;
    return res.status(201).json({ success: true, customer });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};
