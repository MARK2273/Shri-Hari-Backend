import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { mockStore, saveMockStore, recordAuditLog } from '../utils/mockStore';
import { inMemBatches, inMemMaterials } from './materials.controller';
import { inMemProducts } from './products.controller';
import { inMemCustomers } from './orders.controller';
import { inMemFGBatches, InMemFGBatch } from './finishedGoods.controller';

const getTenantId = (req: Request): string =>
  (req.tenantId || process.env.DEFAULT_TENANT_SLUG || 'shri-hari-pack') as string;

// 1. GET & CREATE Job Workers (Vendors/Processors)
export const getJobWorkers = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const workers = (mockStore.jobWorkers || []).filter(
      (w) => !w.tenant_id || w.tenant_id === tenantId
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
      (o) => !o.tenant_id || o.tenant_id === tenantId
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

    const material = (mockStore.materials || inMemMaterials || []).find((m) => m.id === materialId);
    if (!material) {
      return res.status(404).json({ error: 'Selected raw material not found in master catalog' });
    }

    // Find batch: either specified batch, or auto-pick batch with available stock for this material
    let sourceBatch = sourceBatchId
      ? (mockStore.batches || inMemBatches || []).find((b) => b.id === sourceBatchId)
      : null;

    if (!sourceBatch) {
      const candidateBatches = (mockStore.batches || inMemBatches || []).filter(
        (b) => b.material_id === materialId && Number(b.remaining_quantity_kg) > 0
      );
      if (candidateBatches.length > 0) {
        // Prefer batch with sufficient stock, or the first available lot
        sourceBatch = candidateBatches.find((b) => Number(b.remaining_quantity_kg) >= qty) || candidateBatches[0];
      }
    }

    if (!sourceBatch) {
      return res.status(400).json({
        error: `No available warehouse stock batch found for ${material.name}. Please receive stock in warehouse first.`,
      });
    }

    if (Number(sourceBatch.remaining_quantity_kg) < qty) {
      return res.status(400).json({
        error: `Insufficient stock in lot ${sourceBatch.batch_number}. Available: ${sourceBatch.remaining_quantity_kg} kg, Requested: ${qty} kg`,
      });
    }

    // Deduct stock from warehouse batch
    sourceBatch.remaining_quantity_kg = Number((Number(sourceBatch.remaining_quantity_kg) - qty).toFixed(2));
    if (sourceBatch.remaining_quantity_kg <= 0) {
      sourceBatch.remaining_quantity_kg = 0;
      sourceBatch.status = 'depleted';
    }

    // Create Outward Challan
    const challanNumber = `JW-OUT-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}-${Math.floor(100 + Math.random() * 900)}`;
    const outwardRecord = {
      id: `jwo-${Date.now()}`,
      tenant_id: tenantId,
      challan_number: challanNumber,
      vendor_id: vendor.id,
      vendor_name: vendor.name,
      material_id: materialId,
      material_name: material?.name || 'Raw Material',
      source_batch_id: sourceBatch.id,
      source_batch_number: sourceBatch.batch_number,
      quantity_kg: qty,
      dispatch_date: dispatchDate || new Date().toISOString().split('T')[0],
      vehicle_number: vehicleNumber?.trim() || '',
      notes: notes?.trim() || '',
      created_at: new Date().toISOString(),
    };

    mockStore.jobWorkMaterialOutward.unshift(outwardRecord);
    recordAuditLog(
      'JOB_WORK_OUTWARD',
      `Sent ${qty} kg of ${material?.name || 'Material'} to Job Worker ${vendor.name} via ${challanNumber}`,
      outwardRecord,
      req.user?.email
    );
    saveMockStore();

    res.status(201).json({ success: true, outward: outwardRecord });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to record outward material dispatch', message: err.message });
  }
};

// 3. Real-Time Stock Held with Each Job Worker
export const getVendorStockBalances = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const workers = (mockStore.jobWorkers || []).filter(
      (w) => !w.tenant_id || w.tenant_id === tenantId
    );
    const outward = (mockStore.jobWorkMaterialOutward || []).filter(
      (o) => !o.tenant_id || o.tenant_id === tenantId
    );
    const receipts = (mockStore.jobWorkReceipts || []).filter(
      (r) => !r.tenant_id || r.tenant_id === tenantId
    );

    // Build map of vendor -> material -> { totalSent, totalConsumed, balance }
    const vendorBalances = workers.map((worker) => {
      const vendorOutward = outward.filter((o) => o.vendor_id === worker.id);
      const vendorReceipts = receipts.filter((r) => r.vendor_id === worker.id);

      const materialMap: Record<string, { material_id: string; material_name: string; sent_kg: number; consumed_kg: number; balance_kg: number }> = {};

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
        balance_kg: Number((m.sent_kg - m.consumed_kg).toFixed(2)),
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
      (o) => !o.tenant_id || o.tenant_id === tenantId
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

    const product = (mockStore.products || inMemProducts || []).find((p) => p.id === productId);
    const recipe =
      product?.product_recipes?.find((r: any) => r.id === recipeId) ||
      product?.product_recipes?.[0];

    const customer = customerId
      ? (mockStore.customers || inMemCustomers || []).find((c) => c.id === customerId)
      : null;

    const orderNumber = `JWO-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}-${Math.floor(100 + Math.random() * 900)}`;

    const newOrder = {
      id: `jword-${Date.now()}`,
      tenant_id: tenantId,
      order_number: orderNumber,
      vendor_id: vendor.id,
      vendor_name: vendor.name,
      product_id: productId,
      product_name: product?.name || 'Manufactured Item',
      recipe_id: recipe?.id || '',
      recipe_items: recipe?.recipe_items || [],
      planned_quantity_kg: plannedKg,
      received_quantity_kg: 0,
      scrap_quantity_kg: 0,
      customer_id: customer?.id || null,
      customer_name: customer?.name || null,
      target_size: targetSize || 'Standard Roll',
      target_micron: targetMicron || 50,
      status: 'in_progress' as const,
      expected_delivery_date: expectedDeliveryDate || null,
      notes: notes?.trim() || '',
      created_at: new Date().toISOString(),
    };

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
    res.status(500).json({ error: 'Failed to create job work order', message: err.message });
  }
};

// 5. Receive Finished Goods (Inward to Warehouse Stock OR Direct Customer Dispatch)
export const receiveJobWorkFinishedGoods = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const {
      orderId,
      acceptedQuantityKg,
      scrapQuantityKg,
      deliveryDestination, // 'factory_stock' | 'direct_customer'
      vehicleNumber,
      deliveryDate,
      notes,
    } = req.body;

    const acceptedKg = Number(acceptedQuantityKg);
    const scrapKg = Number(scrapQuantityKg) || 0;

    if (!orderId || isNaN(acceptedKg) || acceptedKg <= 0) {
      return res.status(400).json({ error: 'Order ID and positive accepted quantity are required.' });
    }

    const order = (mockStore.jobWorkOrders || []).find((o) => o.id === orderId);
    if (!order) {
      return res.status(404).json({ error: 'Job work order not found' });
    }

    const vendor = (mockStore.jobWorkers || []).find((w) => w.id === order.vendor_id);
    const product = (mockStore.products || inMemProducts || []).find((p) => p.id === order.product_id);
    const totalInputConsumed = acceptedKg + scrapKg;

    // Calculate raw materials consumed from vendor based on recipe
    const recipeItems = order.recipe_items || product?.product_recipes?.[0]?.recipe_items || [];
    const materialsConsumed = recipeItems.map((item: any) => {
      const mat = (mockStore.materials || inMemMaterials || []).find((m) => m.id === item.material_id);
      const ratio = Number(item.percentage) || 100;
      const consumedKg = Number(((ratio / 100) * totalInputConsumed).toFixed(2));
      return {
        material_id: item.material_id,
        material_name: mat?.name || item.material_name || 'Material',
        percentage: ratio,
        consumed_kg: consumedKg,
      };
    });

    // If no recipe configured, treat as generic material consumption
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
      const newFGBatch: InMemFGBatch = {
        id: `fg-${Date.now()}`,
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
      fgBatchId = newFGBatch.id;
    }

    // B. Route Directly to Customer (Auto-Dispatch Note)
    let deliveryId = '';
    if (deliveryDestination === 'direct_customer' && order.customer_id) {
      const customer = (mockStore.customers || inMemCustomers || []).find((c) => c.id === order.customer_id);
      const deliveryDoc = `DEL-JW-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(100 + Math.random() * 900)}`;
      const newDelivery = {
        id: `del-${Date.now()}`,
        tenant_id: tenantId,
        delivery_number: deliveryDoc,
        order_id: null,
        customer_id: order.customer_id,
        customer_name: customer?.name || order.customer_name,
        destination_address: customer?.delivery_address || 'Customer Plant',
        vehicle_number: vehicleNumber?.trim() || 'Third-Party Logistics',
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
      deliveryId = newDelivery.id;
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
      customer_id: order.customer_id,
      customer_name: order.customer_name,
      fg_batch_id: fgBatchId,
      delivery_id: deliveryId,
      vehicle_number: vehicleNumber?.trim() || '',
      delivery_date: deliveryDate || new Date().toISOString().split('T')[0],
      notes: notes?.trim() || '',
      created_at: new Date().toISOString(),
    };

    if (!mockStore.jobWorkReceipts) mockStore.jobWorkReceipts = [];
    mockStore.jobWorkReceipts.unshift(receiptRecord);

    // Update Job Work Order Progress
    order.received_quantity_kg = Number(((order.received_quantity_kg || 0) + acceptedKg).toFixed(2));
    order.scrap_quantity_kg = Number(((order.scrap_quantity_kg || 0) + scrapKg).toFixed(2));
    if (order.received_quantity_kg >= order.planned_quantity_kg) {
      order.status = 'completed';
    }

    recordAuditLog(
      'JOB_WORK_RECEIPT',
      `Received ${acceptedKg} kg of ${order.product_name} from Job Worker ${order.vendor_name} (${deliveryDestination === 'direct_customer' ? 'Direct to Customer' : 'Stocked in Warehouse'})`,
      receiptRecord,
      req.user?.email
    );
    saveMockStore();

    res.status(201).json({ success: true, receipt: receiptRecord, order });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to process job work goods receipt', message: err.message });
  }
};

// 6. Get Receipts History
export const getJobWorkReceipts = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const receipts = (mockStore.jobWorkReceipts || []).filter(
      (r) => !r.tenant_id || r.tenant_id === tenantId
    );
    res.json({ success: true, receipts });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch receipts history', message: err.message });
  }
};
