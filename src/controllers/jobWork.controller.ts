import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { mockStore, saveMockStore, recordAuditLog } from '../utils/mockStore';
import { inMemBatches, inMemMaterials } from './materials.controller';
import { inMemProducts } from './products.controller';
import { inMemCustomers } from './orders.controller';
import { inMemFGBatches, InMemFGBatch } from './finishedGoods.controller';

const getTenantId = (req: Request): string =>
  (req.tenantId || process.env.DEFAULT_TENANT_SLUG || 'shri-hari-pack') as string;

// Helper: Find material across Supabase and inMem
async function findMaterial(materialId: string, tenantId: string) {
  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from('materials')
        .select('*')
        .eq('id', materialId)
        .maybeSingle();
      if (data && !error) return data;
    } catch (err) {
      console.warn('Supabase material query fallback:', err);
    }
  }
  return (mockStore.materials || inMemMaterials || []).find((m) => m.id === materialId);
}

// Helper: Find batch across Supabase and inMem
async function findBatch(batchId: string, tenantId: string) {
  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from('material_batches')
        .select('*')
        .eq('id', batchId)
        .maybeSingle();
      if (data && !error) return data;
    } catch (err) {
      console.warn('Supabase batch query fallback:', err);
    }
  }
  return (mockStore.batches || inMemBatches || []).find((b) => b.id === batchId);
}

// Helper: Find available batches for a material with positive remaining quantity
async function findAvailableBatchesForMaterial(materialId: string, tenantId: string) {
  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from('material_batches')
        .select('*')
        .eq('material_id', materialId)
        .gt('remaining_quantity_kg', 0)
        .order('created_at', { ascending: true });
      if (data && !error && data.length > 0) return data;
    } catch (err) {
      console.warn('Supabase available batches fallback:', err);
    }
  }
  return (mockStore.batches || inMemBatches || []).filter(
    (b) => b.material_id === materialId && Number(b.remaining_quantity_kg) > 0
  );
}

// Helper: Find product across Supabase and inMem
async function findProduct(productId: string, tenantId: string) {
  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from('products')
        .select(`
          *,
          product_recipes (
            id,
            version,
            is_active,
            notes,
            effective_date,
            product_recipe_items (
              id,
              material_id,
              percentage,
              planned_kg_per_kg_output,
              materials (id, name, code)
            )
          )
        `)
        .eq('id', productId)
        .maybeSingle();

      if (data && !error) return data;

      // Fallback simple query in case nested relations differ
      const { data: simpleData } = await supabase
        .from('products')
        .select('*')
        .eq('id', productId)
        .maybeSingle();

      if (simpleData) return simpleData;
    } catch (err) {
      console.warn('Supabase product query fallback:', err);
    }
  }
  return (mockStore.products || inMemProducts || []).find((p) => p.id === productId);
}

// Helper: Find customer across Supabase and inMem
async function findCustomer(customerId: string, tenantId: string) {
  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase
        .from('customers')
        .select('*')
        .eq('id', customerId)
        .maybeSingle();
      if (data && !error) return data;
    } catch (err) {
      console.warn('Supabase customer query fallback:', err);
    }
  }
  return (mockStore.customers || inMemCustomers || []).find((c) => c.id === customerId);
}

// 1. GET & CREATE Job Workers (Vendors/Processors)
export const getJobWorkers = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const workers = (mockStore.jobWorkers || []).filter(
      (w) => !w.tenant_id || w.tenant_id === tenantId || w.tenant_id === 'shri-hari-pack'
    );
    res.json({ success: true, workers });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch job workers', message: err.message });
  }
};

export const createJobWorker = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { name, contactPerson, phone, email, address } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: 'Job worker name is required' });
    }

    const newWorker = {
      id: `jw-${Date.now()}`,
      tenant_id: tenantId,
      name: name.trim(),
      contact_person: contactPerson?.trim() || '',
      phone: phone?.trim() || '',
      email: email?.trim() || '',
      address: address?.trim() || '',
      is_active: true,
      created_at: new Date().toISOString(),
    };

    if (!mockStore.jobWorkers) mockStore.jobWorkers = [];
    mockStore.jobWorkers.push(newWorker);
    recordAuditLog('CREATE_JOB_WORKER', `Created job worker: ${newWorker.name}`, newWorker, req.user?.email);
    saveMockStore();

    res.status(201).json({ success: true, worker: newWorker });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create job worker', message: err.message });
  }
};

// 2. Outward Material Dispatch (Warehouse -> Job Worker)
export const getMaterialOutward = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const outward = (mockStore.jobWorkMaterialOutward || []).filter(
      (o) => !o.tenant_id || o.tenant_id === tenantId || o.tenant_id === 'shri-hari-pack'
    );
    res.json({ success: true, outward });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch material outward list', message: err.message });
  }
};

export const createMaterialOutward = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { vendorId, materialId, sourceBatchId, quantityKg, vehicleNumber, dispatchDate, notes } = req.body;

    const qty = Number(quantityKg);
    if (!vendorId || !materialId || isNaN(qty) || qty <= 0) {
      return res.status(400).json({ error: 'Vendor, raw material, and a positive quantity greater than 0 are required.' });
    }

    const vendor = (mockStore.jobWorkers || []).find((w) => w.id === vendorId);
    if (!vendor) {
      return res.status(404).json({ error: 'Job worker vendor not found' });
    }

    // Resolve material across Supabase and inMem
    const material = await findMaterial(materialId, tenantId);
    if (!material) {
      return res.status(404).json({ error: 'Selected raw material not found in master catalog' });
    }

    // Resolve source batch across Supabase and inMem
    let sourceBatch: any = null;
    if (sourceBatchId) {
      sourceBatch = await findBatch(sourceBatchId, tenantId);
    } else {
      const candidates = await findAvailableBatchesForMaterial(materialId, tenantId);
      if (candidates && candidates.length > 0) {
        sourceBatch = candidates.find((b: any) => Number(b.remaining_quantity_kg) >= qty) || candidates[0];
      }
    }

    if (!sourceBatch) {
      return res.status(400).json({
        error: `No available warehouse stock batch found for ${material.name}. Please receive stock in warehouse first.`,
      });
    }

    const currentRemaining = Number(sourceBatch.remaining_quantity_kg) || 0;
    if (currentRemaining < qty) {
      return res.status(400).json({
        error: `Insufficient stock in lot ${sourceBatch.batch_number}. Available: ${currentRemaining} kg, Requested: ${qty} kg`,
      });
    }

    const newRemaining = Number(Math.max(0, currentRemaining - qty).toFixed(2));
    const newStatus = newRemaining <= 0 ? 'depleted' : 'available';

    // 1. Deduct stock from Supabase database table if configured
    if (isSupabaseConfigured && supabase) {
      try {
        const { error: updateErr } = await supabase
          .from('material_batches')
          .update({
            remaining_quantity_kg: newRemaining,
            status: newStatus,
          })
          .eq('id', sourceBatch.id);

        if (updateErr) {
          console.error('Supabase batch stock update error:', updateErr);
        }
      } catch (dbErr) {
        console.error('Failed to update Supabase batch stock:', dbErr);
      }
    }

    // 2. Also deduct stock in local inMem / mockStore
    const inMemB = (mockStore.batches || inMemBatches || []).find((b) => b.id === sourceBatch.id);
    if (inMemB) {
      inMemB.remaining_quantity_kg = newRemaining;
      inMemB.status = newStatus;
    }

    // 3. Create Outward Challan Record
    const challanNumber = `JW-OUT-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}-${Math.floor(100 + Math.random() * 900)}`;
    const outwardRecord = {
      id: `jwo-${Date.now()}`,
      tenant_id: tenantId,
      challan_number: challanNumber,
      vendor_id: vendor.id,
      vendor_name: vendor.name,
      material_id: materialId,
      material_name: material.name || 'Raw Material',
      source_batch_id: sourceBatch.id,
      source_batch_number: sourceBatch.batch_number,
      quantity_kg: qty,
      dispatch_date: dispatchDate || new Date().toISOString().split('T')[0],
      vehicle_number: vehicleNumber?.trim() || '',
      notes: notes?.trim() || '',
      created_at: new Date().toISOString(),
    };

    if (!mockStore.jobWorkMaterialOutward) mockStore.jobWorkMaterialOutward = [];
    mockStore.jobWorkMaterialOutward.unshift(outwardRecord);

    recordAuditLog(
      'JOB_WORK_OUTWARD',
      `Sent ${qty} kg of ${material.name} to Job Worker ${vendor.name} via ${challanNumber}`,
      outwardRecord,
      req.user?.email
    );
    saveMockStore();

    res.status(201).json({ success: true, outward: outwardRecord });
  } catch (err: any) {
    console.error('Error in createMaterialOutward:', err);
    res.status(500).json({ error: 'Failed to record outward material dispatch', message: err.message });
  }
};

// 3. Real-Time Stock Held with Each Job Worker
export const getVendorStockBalances = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    const workers = (mockStore.jobWorkers || []).filter(
      (w) => !w.tenant_id || w.tenant_id === tenantId || w.tenant_id === 'shri-hari-pack'
    );
    const outwardList = (mockStore.jobWorkMaterialOutward || []).filter(
      (o) => !o.tenant_id || o.tenant_id === tenantId || o.tenant_id === 'shri-hari-pack'
    );
    const receiptsList = (mockStore.jobWorkReceipts || []).filter(
      (r) => !r.tenant_id || r.tenant_id === tenantId || r.tenant_id === 'shri-hari-pack'
    );

    const vendorBalances = workers.map((worker) => {
      const vendorOutward = outwardList.filter((o) => o.vendor_id === worker.id);
      const vendorReceipts = receiptsList.filter((r) => r.vendor_id === worker.id);

      const materialMap: Record<
        string,
        { material_id: string; material_name: string; sent_kg: number; consumed_kg: number; balance_kg: number }
      > = {};

      vendorOutward.forEach((o) => {
        if (!materialMap[o.material_id]) {
          materialMap[o.material_id] = {
            material_id: o.material_id,
            material_name: o.material_name,
            sent_kg: 0,
            consumed_kg: 0,
            balance_kg: 0,
          };
        }
        materialMap[o.material_id].sent_kg += Number(o.quantity_kg) || 0;
      });

      vendorReceipts.forEach((r) => {
        if (Array.isArray(r.materials_consumed)) {
          r.materials_consumed.forEach((c: any) => {
            if (!materialMap[c.material_id]) {
              materialMap[c.material_id] = {
                material_id: c.material_id,
                material_name: c.material_name,
                sent_kg: 0,
                consumed_kg: 0,
                balance_kg: 0,
              };
            }
            materialMap[c.material_id].consumed_kg += Number(c.consumed_kg) || 0;
          });
        }
      });

      const materialsHeld = Object.values(materialMap).map((m) => ({
        ...m,
        sent_kg: Number(m.sent_kg.toFixed(2)),
        consumed_kg: Number(m.consumed_kg.toFixed(2)),
        balance_kg: Number(Math.max(0, m.sent_kg - m.consumed_kg).toFixed(2)),
      }));

      const totalBalanceKg = materialsHeld.reduce((sum, m) => sum + Math.max(0, m.balance_kg), 0);

      return {
        vendor_id: worker.id,
        vendor_name: worker.name,
        contact_person: worker.contact_person,
        phone: worker.phone,
        address: worker.address,
        total_balance_kg: Number(totalBalanceKg.toFixed(2)),
        materials: materialsHeld,
      };
    });

    res.json({ success: true, vendorBalances });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to calculate vendor stock balances', message: err.message });
  }
};

// 4. Job Work Production Orders
export const getJobWorkOrders = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const orders = (mockStore.jobWorkOrders || []).filter(
      (o) => !o.tenant_id || o.tenant_id === tenantId || o.tenant_id === 'shri-hari-pack'
    );
    res.json({ success: true, orders });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch job work orders', message: err.message });
  }
};

export const createJobWorkOrder = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const {
      vendorId,
      productId,
      recipeId,
      plannedQuantityKg,
      customerId,
      targetSize,
      targetMicron,
      expectedDeliveryDate,
      instructions,
      notes,
    } = req.body;

    const plannedKg = Number(plannedQuantityKg);
    if (!vendorId || !productId || isNaN(plannedKg) || plannedKg <= 0) {
      return res.status(400).json({ error: 'Vendor, target product, and positive planned quantity are required.' });
    }

    const vendor = (mockStore.jobWorkers || []).find((w) => w.id === vendorId);
    if (!vendor) {
      return res.status(404).json({ error: 'Job worker vendor not found' });
    }

    // Resolve product across Supabase and inMem
    const product = await findProduct(productId, tenantId);
    if (!product) {
      return res.status(404).json({ error: 'Selected product not found in catalog' });
    }

    const recipesList = product?.product_recipes || product?.recipes || [];
    const recipe =
      recipesList.find((r: any) => r.id === recipeId) ||
      recipesList.find((r: any) => r.is_active) ||
      recipesList.find((r: any) => r.is_default) ||
      recipesList[0];

    // Resolve customer if passed
    let customer: any = null;
    if (customerId) {
      customer = await findCustomer(customerId, tenantId);
    }

    const orderNumber = `JWO-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}-${Math.floor(100 + Math.random() * 900)}`;
    const recipeName =
      recipe?.name || (recipe?.version ? `Recipe v${recipe.version}` : 'Standard Formulation');
    const normalizedRecipeItems = (recipe?.product_recipe_items || recipe?.recipe_items || []).map((it: any) => ({
      id: it.id,
      material_id: it.material_id,
      material_name: it.materials?.name || it.material_name || 'Raw Material',
      percentage: Number(it.percentage) || 0,
      planned_kg_per_kg_output: Number(it.planned_kg_per_kg_output) || 1,
    }));

    const newOrder = {
      id: `jword-${Date.now()}`,
      tenant_id: tenantId,
      order_number: orderNumber,
      vendor_id: vendor.id,
      vendor_name: vendor.name,
      product_id: productId,
      product_name: product?.name || 'Manufactured Item',
      recipe_id: recipe?.id || '',
      recipe_name: recipeName,
      recipe_items: normalizedRecipeItems,
      planned_quantity_kg: plannedKg,
      received_quantity_kg: 0,
      scrap_quantity_kg: 0,
      customer_id: customer?.id || null,
      customer_name: customer?.name || null,
      target_size: targetSize || 'Standard Roll',
      target_micron: targetMicron || 50,
      status: 'in_progress' as const,
      expected_delivery_date: expectedDeliveryDate || null,
      instructions: instructions || notes?.trim() || '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (!mockStore.jobWorkOrders) mockStore.jobWorkOrders = [];
    mockStore.jobWorkOrders.unshift(newOrder);

    recordAuditLog(
      'CREATE_JOB_WORK_ORDER',
      `Issued Job Work Order ${orderNumber} to ${vendor.name} for ${plannedKg} kg of ${product?.name}`,
      newOrder,
      req.user?.email
    );
    saveMockStore();

    res.status(201).json({ success: true, order: newOrder });
  } catch (err: any) {
    console.error('Error in createJobWorkOrder:', err);
    res.status(500).json({ error: 'Failed to create job work order', message: err.message });
  }
};

// 5. Receive Finished Goods (Inward to Warehouse Stock OR Direct Customer Dispatch)
export const receiveJobWorkFinishedGoods = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const orderId = req.body.jobWorkOrderId || req.body.orderId;
    const acceptedKg = Number(req.body.acceptedQuantityKg);
    const scrapKg = Number(req.body.scrapQuantityKg) || 0;
    const deliveryDestination = req.body.deliveryDestination || 'factory_stock';
    const customerId = req.body.customerId;
    const vehicleNumber = req.body.vehicleNumber;
    const deliveryDate = req.body.deliveryDate;
    const notes = req.body.notes;

    if (!orderId || isNaN(acceptedKg) || acceptedKg <= 0) {
      return res.status(400).json({ error: 'Job work order ID and positive accepted quantity are required.' });
    }

    const order = (mockStore.jobWorkOrders || []).find((o) => o.id === orderId);
    if (!order) {
      return res.status(404).json({ error: 'Job work order not found' });
    }

    const vendor = (mockStore.jobWorkers || []).find((w) => w.id === order.vendor_id);
    const totalInputConsumed = acceptedKg + scrapKg;

    // Resolve recipe formulation items for raw materials consumed deduction
    let recipeItems: any[] = [];
    if (order.recipe_id && isSupabaseConfigured && supabase) {
      try {
        const { data: rItems } = await supabase
          .from('product_recipe_items')
          .select('*, materials(name)')
          .eq('recipe_id', order.recipe_id);
        if (rItems && rItems.length > 0) {
          recipeItems = rItems.map((it: any) => ({
            material_id: it.material_id,
            material_name: it.materials?.name || 'Raw Material',
            percentage: Number(it.percentage) || 0,
          }));
        }
      } catch (err) {
        console.warn('Recipe query fallback:', err);
      }
    }

    if (recipeItems.length === 0 && Array.isArray(order.recipe_items) && order.recipe_items.length > 0) {
      recipeItems = order.recipe_items;
    }

    const materialsConsumed = recipeItems.map((item: any) => {
      const ratio = Number(item.percentage) || 100;
      const consumedKg = Number(((ratio / 100) * totalInputConsumed).toFixed(2));
      return {
        material_id: item.material_id,
        material_name: item.material_name || item.materials?.name || 'Polymer',
        percentage: ratio,
        consumed_kg: consumedKg,
      };
    });

    if (materialsConsumed.length === 0) {
      materialsConsumed.push({
        material_id: 'gen-poly',
        material_name: 'Raw Polymer',
        percentage: 100,
        consumed_kg: totalInputConsumed,
      });
    }

    const receiptNumber = `JW-REC-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}-${Math.floor(100 + Math.random() * 900)}`;

    // A. Route to Factory Finished Goods Stock
    let fgBatchId = '';
    if (deliveryDestination !== 'direct_customer') {
      const lotNumber = `FG-JW-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`;

      if (isSupabaseConfigured && supabase) {
        try {
          const pbBatchNumber = `PB-JW-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`;
          const { data: pbData, error: pbErr } = await supabase
            .from('production_batches')
            .insert({
              tenant_id: tenantId,
              batch_number: pbBatchNumber,
              product_id: order.product_id,
              operator_name: `${vendor?.name || 'Job Worker'} (Outsourced)`,
              status: 'completed',
              total_input_kg: totalInputConsumed,
              accepted_output_kg: acceptedKg,
              waste_kg: scrapKg,
              start_time: new Date().toISOString(),
              completion_time: new Date().toISOString(),
            })
            .select()
            .maybeSingle();

          if (pbData && !pbErr) {
            const { data: fgData } = await supabase
              .from('finished_goods_batches')
              .insert({
                tenant_id: tenantId,
                production_batch_id: pbData.id,
                product_id: order.product_id,
                batch_number: lotNumber,
                quantity_produced_kg: acceptedKg,
                quantity_on_hand_kg: acceptedKg,
                quantity_reserved_kg: 0,
                quantity_dispatched_kg: 0,
                status: 'in_stock',
                created_at: new Date().toISOString(),
              })
              .select()
              .maybeSingle();

            if (fgData) fgBatchId = fgData.id;
          }
        } catch (dbErr) {
          console.error('Failed to record FG batch in Supabase:', dbErr);
        }
      }

      const newFGBatch: InMemFGBatch = {
        id: fgBatchId || `fg-${Date.now()}`,
        tenant_id: tenantId,
        production_batch_id: order.id,
        product_id: order.product_id,
        batch_number: lotNumber,
        quantity_on_hand_kg: acceptedKg,
        quantity_reserved_kg: 0,
        quantity_dispatched_kg: 0,
        status: 'in_stock',
        created_at: new Date().toISOString(),
      };

      if (!mockStore.fgBatches) mockStore.fgBatches = [];
      mockStore.fgBatches.unshift(newFGBatch);
      inMemFGBatches.unshift(newFGBatch);
      if (!fgBatchId) fgBatchId = newFGBatch.id;
    }

    // B. Route Directly to Customer (Auto-Dispatch Note)
    let deliveryId = '';
    const destCustId = customerId || order.customer_id;
    if (deliveryDestination === 'direct_customer' && destCustId) {
      const customer = await findCustomer(destCustId, tenantId);
      const deliveryDoc = `DEL-JW-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`;

      if (isSupabaseConfigured && supabase) {
        try {
          const { data: delData } = await supabase
            .from('deliveries')
            .insert({
              tenant_id: tenantId,
              delivery_number: deliveryDoc,
              customer_id: destCustId,
              dispatch_date: deliveryDate || new Date().toISOString(),
              destination_address: customer?.delivery_address || customer?.address || customer?.city || 'Customer Plant',
              vehicle_number: vehicleNumber?.trim() || 'Direct Dispatch',
              status: 'delivered',
              created_at: new Date().toISOString(),
            })
            .select()
            .maybeSingle();

          if (delData) {
            deliveryId = delData.id;
            await supabase.from('delivery_items').insert({
              delivery_id: delData.id,
              product_id: order.product_id,
              quantity_kg: acceptedKg,
            });
          }
        } catch (delErr) {
          console.error('Failed to create delivery in Supabase:', delErr);
        }
      }

      const newDelivery = {
        id: deliveryId || `del-${Date.now()}`,
        tenant_id: tenantId,
        delivery_number: deliveryDoc,
        order_id: null,
        customer_id: destCustId,
        customer_name: customer?.name || order.customer_name,
        destination_address: customer?.delivery_address || customer?.address || customer?.city || 'Customer Plant',
        vehicle_number: vehicleNumber?.trim() || 'Direct Dispatch',
        dispatch_date: deliveryDate || new Date().toISOString(),
        delivery_items: [
          {
            id: `deli-${Date.now()}`,
            product_id: order.product_id,
            product_name: order.product_name,
            quantity_kg: acceptedKg,
          },
        ],
        notes: `Direct fulfillment from Job Worker: ${vendor?.name || ''}`,
        created_at: new Date().toISOString(),
      };

      if (!mockStore.deliveries) mockStore.deliveries = [];
      mockStore.deliveries.unshift(newDelivery);
      if (!deliveryId) deliveryId = newDelivery.id;
    }

    // Record Inward Receipt
    const receiptRecord = {
      id: `jwr-${Date.now()}`,
      tenant_id: tenantId,
      receipt_number: receiptNumber,
      job_work_order_id: order.id,
      job_work_order_number: order.order_number,
      vendor_id: order.vendor_id,
      vendor_name: order.vendor_name,
      product_id: order.product_id,
      product_name: order.product_name,
      accepted_quantity_kg: acceptedKg,
      scrap_quantity_kg: scrapKg,
      total_input_consumed_kg: totalInputConsumed,
      materials_consumed: materialsConsumed,
      delivery_destination: deliveryDestination || 'factory_stock',
      customer_id: destCustId || null,
      customer_name: order.customer_name || null,
      fg_batch_id: fgBatchId,
      delivery_id: deliveryId,
      vehicle_number: vehicleNumber?.trim() || '',
      delivery_date: deliveryDate || new Date().toISOString().split('T')[0],
      notes: notes?.trim() || '',
      created_at: new Date().toISOString(),
    };

    if (!mockStore.jobWorkReceipts) mockStore.jobWorkReceipts = [];
    mockStore.jobWorkReceipts.unshift(receiptRecord);

    // Update Order progress
    order.received_quantity_kg = Number(((order.received_quantity_kg || 0) + acceptedKg).toFixed(2));
    order.scrap_quantity_kg = Number(((order.scrap_quantity_kg || 0) + scrapKg).toFixed(2));
    if (order.received_quantity_kg >= order.planned_quantity_kg) {
      order.status = 'completed';
    } else {
      order.status = 'in_progress';
    }
    order.updated_at = new Date().toISOString();

    recordAuditLog(
      'JOB_WORK_RECEIPT',
      `Received ${acceptedKg} kg for Job Work Order ${order.order_number} from ${vendor?.name}`,
      receiptRecord,
      req.user?.email
    );
    saveMockStore();

    res.status(201).json({ success: true, receipt: receiptRecord, order });
  } catch (err: any) {
    console.error('Error in receiveJobWorkFinishedGoods:', err);
    res.status(500).json({ error: 'Failed to record inward receipt', message: err.message });
  }
};

export const getJobWorkReceipts = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const receipts = (mockStore.jobWorkReceipts || []).filter(
      (r) => !r.tenant_id || r.tenant_id === tenantId || r.tenant_id === 'shri-hari-pack'
    );
    res.json({ success: true, receipts });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch job work receipts', message: err.message });
  }
};
