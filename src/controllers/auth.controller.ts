import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { verifyPassword, hashPassword } from '../utils/hash';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantSlug: z.string().optional(),
  tenantId: z.string().optional()
});

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password, tenantSlug, tenantId } = loginSchema.parse(req.body);
    const resolvedTenantSlug = tenantSlug || tenantId || (req.headers['x-tenant-id'] as string) || process.env.DEFAULT_TENANT_SLUG || 'shri-hari-pack';

    if (!isSupabaseConfigured) {
      // Development mode fallback when Supabase keys are pending
      if (email.includes('shrihari.com') && (password === 'Admin@123' || password === 'admin')) {
        const mockTenantId = '11111111-1111-1111-1111-111111111111';
        const role = email.startsWith('admin') ? 'factory_admin' : email.startsWith('supervisor') ? 'supervisor' : 'operator';
        const token = jwt.sign(
          {
            id: '22222222-2222-2222-2222-222222222222',
            email,
            tenant_id: mockTenantId,
            role,
            full_name: email.split('@')[0].toUpperCase()
          },
          process.env.JWT_SECRET || 'shri_hari_packaging_secret_jwt_key_2026_super_secure!',
          { expiresIn: '7d' }
        );
        return res.json({
          success: true,
          token,
          user: {
            id: '22222222-2222-2222-2222-222222222222',
            email,
            full_name: email.split('@')[0].toUpperCase(),
            role,
            tenant_id: mockTenantId,
            tenant_name: 'Shri Hari Packaging Factory (Dev Mode)'
          }
        });
      }
      return res.status(400).json({
        success: false,
        message: 'Supabase credentials not configured in backend/.env yet. Please provide your Supabase details or use admin@shrihari.com / Admin@123.'
      });
    }

    // Query user
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*, tenants(id, tenant_id, name, status)')
      .eq('email', email)
      .eq('is_active', true)
      .single();

    if (userError || !user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials or inactive user account.' });
    }

    // Tenant verification
    if (resolvedTenantSlug && user.role !== 'platform_admin') {
      if (user.tenants?.tenant_id !== resolvedTenantSlug) {
        return res.status(403).json({
          success: false,
          message: `User does not belong to factory '${resolvedTenantSlug}'.`
        });
      }
    }

    if (user.tenants && user.tenants.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: `Tenant account '${user.tenants.name}' is currently ${user.tenants.status}. Please contact platform admin.`
      });
    }

    const isMatch = await verifyPassword(user.password_hash, password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    const tokenPayload = {
      id: user.id,
      email: user.email,
      tenant_id: user.tenant_id,
      role: user.role,
      full_name: user.full_name
    };

    const token = jwt.sign(
      tokenPayload,
      process.env.JWT_SECRET || 'shri_hari_packaging_secret_jwt_key_2026_super_secure!',
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        tenant_id: user.tenant_id,
        tenant_name: user.tenants?.name || 'Shri Hari Packaging'
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    console.error('[AUTH] Login error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const getProfile = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    if (!isSupabaseConfigured) {
      return res.json({
        success: true,
        user: {
          ...req.user,
          tenant_name: 'Shri Hari Packaging Factory (Dev Mode)'
        }
      });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, full_name, role, phone, tenant_id, tenants(id, tenant_id, name, status)')
      .eq('id', req.user.id)
      .single();

    if (error || !user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.json({ success: true, user });
  } catch (error) {
    console.error('[AUTH] Profile fetch error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const listUsers = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context required' });
    }

    if (!isSupabaseConfigured) {
      return res.json({
        success: true,
        users: [
          { id: '1', email: 'admin@shrihari.com', full_name: 'Rajesh Mehta', role: 'factory_admin', is_active: true },
          { id: '2', email: 'supervisor@shrihari.com', full_name: 'Vikas Patel', role: 'supervisor', is_active: true },
          { id: '3', email: 'operator@shrihari.com', full_name: 'Suresh Kumar', role: 'operator', is_active: true }
        ]
      });
    }

    const { data: users, error } = await supabase
      .from('users')
      .select('id, email, full_name, role, phone, is_active, created_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, users });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createUser = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    const createSchema = z.object({
      email: z.string().email(),
      password: z.string().min(6),
      fullName: z.string().min(1),
      phone: z.string().optional(),
      role: z.enum(['factory_admin', 'supervisor', 'operator', 'dispatch_manager'])
    });

    const parsed = createSchema.parse(req.body);
    const passwordHash = await hashPassword(parsed.password);

    if (!isSupabaseConfigured) {
      return res.json({
        success: true,
        message: 'User created (mock mode)',
        user: { id: 'mock-user-id', email: parsed.email, full_name: parsed.fullName, role: parsed.role }
      });
    }

    const { data: newUser, error } = await supabase
      .from('users')
      .insert({
        email: parsed.email,
        password_hash: passwordHash,
        full_name: parsed.fullName,
        phone: parsed.phone,
        role: parsed.role,
        tenant_id: tenantId
      })
      .select('id, email, full_name, role, phone, is_active')
      .single();

    if (error) throw error;
    return res.status(201).json({ success: true, user: newUser });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};
