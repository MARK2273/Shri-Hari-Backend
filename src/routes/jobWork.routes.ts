import { Router } from 'express';
import {
  getJobWorkers,
  createJobWorker,
  getMaterialOutward,
  createMaterialOutward,
  getVendorStockBalances,
  getJobWorkOrders,
  createJobWorkOrder,
  receiveJobWorkFinishedGoods,
  getJobWorkReceipts,
} from '../controllers/jobWork.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);

// Job Workers (Vendors/Processors)
router.get('/workers', getJobWorkers);
router.post('/workers', requireRole('factory_admin', 'supervisor'), createJobWorker);

// Real-time Stock Balance with Vendors
router.get('/vendor-stock', getVendorStockBalances);

// Material Outward Challans
router.get('/outward', getMaterialOutward);
router.post('/outward', requireRole('factory_admin', 'supervisor', 'operator'), createMaterialOutward);

// Job Work Orders
router.get('/orders', getJobWorkOrders);
router.post('/orders', requireRole('factory_admin', 'supervisor'), createJobWorkOrder);

// Inward Finished Goods Receipts (Stock / Direct Customer)
router.get('/receipts', getJobWorkReceipts);
router.post('/receipts', requireRole('factory_admin', 'supervisor', 'operator'), receiveJobWorkFinishedGoods);

export default router;
