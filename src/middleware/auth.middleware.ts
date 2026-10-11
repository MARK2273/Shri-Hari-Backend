import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface UserPayload {
  id: string;
  email: string;
  tenant_id: string;
  role: 'platform_admin' | 'factory_admin' | 'supervisor' | 'operator' | 'dispatch_manager';
  full_name: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: UserPayload;
      tenantId?: string;
    }
  }
}

export const authenticateToken = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required. Token missing.' });
  }

  try {
    const secret = process.env.JWT_SECRET || 'shri_hari_packaging_secret_jwt_key_2026_super_secure!';
    const decoded = jwt.verify(token, secret) as UserPayload;
    req.user = decoded;
    
    // Resolve tenant ID: platform admins can optionally switch tenant via header 'x-tenant-id'
    const headerTenant = req.headers['x-tenant-id'] as string;
    if (decoded.role === 'platform_admin' && headerTenant) {
      req.tenantId = headerTenant;
    } else {
      req.tenantId = decoded.tenant_id;
    }

    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired session token.' });
  }
};

export const requireRole = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    if (req.user.role === 'platform_admin' || roles.includes(req.user.role)) {
      return next();
    }

    return res.status(403).json({
      success: false,
      message: `Access denied. Requires one of roles: [${roles.join(', ')}]. Current role: '${req.user.role}'`
    });
  };
};
