import { Router } from 'express';
import {
  getOrders,
  createOrder,
  getCustomers,
  createCustomer
} from '../controllers/orders.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateToken);

// Customer orders
router.get('/', getOrders);
router.post('/', requireRole('factory_admin', 'supervisor'), createOrder);

// Customers
router.get('/customers', getCustomers);
router.post('/customers', requireRole('factory_admin', 'supervisor'), createCustomer);

export default router;
