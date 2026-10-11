import { Router } from 'express';
import {
  getProductionVarianceReport,
  getWasteReport,
  getAuditLogs
} from '../controllers/reports.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);

router.get('/variance', getProductionVarianceReport);
router.get('/waste', getWasteReport);
router.get('/audit-logs', requireRole('platform_admin', 'factory_admin'), getAuditLogs);

export default router;
