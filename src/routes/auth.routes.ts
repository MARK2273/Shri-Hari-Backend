import { Router } from 'express';
import { login, getProfile, listUsers, createUser } from '../controllers/auth.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.post('/login', login);
router.get('/me', authenticateToken, getProfile);
router.get('/users', authenticateToken, requireRole('platform_admin', 'factory_admin'), listUsers);
router.post('/users', authenticateToken, requireRole('platform_admin', 'factory_admin'), createUser);

export default router;
