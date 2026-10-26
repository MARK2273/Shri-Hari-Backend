import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';
import {
  getScrapSummary,
  getScrapEntries,
  createScrapEntry,
  getScrapSales,
  createScrapSale,
  deleteScrapSale,
} from '../controllers/scrap.controller';

const router = Router();

router.use(authenticateToken);

router.get('/summary', getScrapSummary);
router.get('/entries', getScrapEntries);
router.post('/entries', requireRole('factory_admin', 'supervisor', 'operator'), createScrapEntry);
router.get('/sales', getScrapSales);
router.post('/sales', requireRole('factory_admin', 'supervisor'), createScrapSale);
router.delete('/sales/:id', requireRole('factory_admin'), deleteScrapSale);

export default router;
