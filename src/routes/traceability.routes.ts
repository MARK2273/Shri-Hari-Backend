import { Router } from 'express';
import { getTraceability } from '../controllers/traceability.controller';
import { authenticateToken } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getTraceability);

export default router;
