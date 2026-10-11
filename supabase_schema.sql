-- ==============================================================================
-- SHRI HARI PACKAGING ERP - MULTI-TENANT PRODUCTION & INVENTORY DATABASE SCHEMA
-- Version: 1.1 (Business Decisions Incorporated)
-- Target: PostgreSQL 14+ / Supabase
-- ==============================================================================

-- 1. Enable Required Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Clean up existing tables if executing fresh (dependency order)
DROP TABLE IF EXISTS attachments CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS inventory_transactions CASCADE;
DROP TABLE IF EXISTS delivery_batch_allocations CASCADE;
DROP TABLE IF EXISTS delivery_items CASCADE;
DROP TABLE IF EXISTS deliveries CASCADE;
DROP TABLE IF EXISTS finished_goods_batches CASCADE;
DROP TABLE IF EXISTS production_outputs CASCADE;
DROP TABLE IF EXISTS production_material_consumption CASCADE;
DROP TABLE IF EXISTS production_batches CASCADE;
DROP TABLE IF EXISTS customer_order_items CASCADE;
DROP TABLE IF EXISTS customer_orders CASCADE;
DROP TABLE IF EXISTS product_recipe_items CASCADE;
DROP TABLE IF EXISTS product_recipes CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS material_batches CASCADE;
DROP TABLE IF EXISTS suppliers CASCADE;
DROP TABLE IF EXISTS materials CASCADE;
DROP TABLE IF EXISTS tenant_memberships CASCADE;
DROP TABLE IF EXISTS user_profiles CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS tenant_settings CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;

-- ==============================================================================
-- 2. TENANTS & CONFIGURATION
-- ==============================================================================

CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id TEXT UNIQUE NOT NULL, -- factory slug (e.g., 'shri-hari-pack')
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deactivated')),
    address TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE tenant_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID UNIQUE NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    standard_weight_unit TEXT NOT NULL DEFAULT 'kg',
    allow_negative_stock BOOLEAN NOT NULL DEFAULT FALSE,
    min_stock_alert_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    suggest_fifo_batch_allocation BOOLEAN NOT NULL DEFAULT TRUE,
    tolerance_percentage NUMERIC(5, 2) NOT NULL DEFAULT 5.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ==============================================================================
-- 3. USERS, ROLES & ACCESS CONTROL
-- ==============================================================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    phone TEXT,
    role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('platform_admin', 'factory_admin', 'supervisor', 'operator', 'dispatch_manager')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User Profiles for extended metadata
CREATE TABLE user_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    avatar_url TEXT,
    department TEXT,
    shift TEXT,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ==============================================================================
-- 4. RAW MATERIALS & SUPPLIERS
-- ==============================================================================

CREATE TABLE suppliers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    contact_person TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_supplier_tenant_code UNIQUE (tenant_id, code)
);

CREATE TABLE materials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code TEXT NOT NULL, -- e.g., 'MAT-TYPE-A'
    name TEXT NOT NULL, -- e.g., 'Plastic Type A'
    description TEXT,
    standard_unit TEXT NOT NULL DEFAULT 'kg',
    min_stock_level_kg NUMERIC(14, 4) NOT NULL DEFAULT 100.0000,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_material_tenant_code UNIQUE (tenant_id, code)
);

CREATE TABLE material_batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    material_id UUID NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
    supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
    batch_number TEXT NOT NULL, -- e.g., 'MB-20261011-001'
    supplier_lot_number TEXT,
    receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
    received_quantity_kg NUMERIC(14, 4) NOT NULL CHECK (received_quantity_kg > 0),
    remaining_quantity_kg NUMERIC(14, 4) NOT NULL CHECK (remaining_quantity_kg >= 0),
    cost_per_kg NUMERIC(12, 2) DEFAULT 0.00,
    status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'depleted', 'quarantined', 'expired')),
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_material_batch_tenant_number UNIQUE (tenant_id, batch_number)
);

-- ==============================================================================
-- 5. CUSTOMERS, PRODUCTS & VERSIONED RECIPES (BOM)
-- ==============================================================================

CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    contact_person TEXT,
    phone TEXT,
    email TEXT,
    billing_address TEXT,
    delivery_address TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_customer_tenant_code UNIQUE (tenant_id, code)
);

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code TEXT NOT NULL, -- e.g., 'PRD-ROLL-01'
    name TEXT NOT NULL,
    description TEXT,
    unit TEXT NOT NULL DEFAULT 'kg' CHECK (unit IN ('kg', 'pcs', 'rolls')),
    standard_weight_kg NUMERIC(14, 4) DEFAULT 1.0000, -- Weight per unit if unit is pcs
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_product_tenant_code UNIQUE (tenant_id, code)
);

CREATE TABLE product_recipes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    version INTEGER NOT NULL DEFAULT 1,
    effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_product_recipe_version UNIQUE (tenant_id, product_id, version)
);

CREATE TABLE product_recipe_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    recipe_id UUID NOT NULL REFERENCES product_recipes(id) ON DELETE CASCADE,
    material_id UUID NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
    percentage NUMERIC(6, 3) NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
    planned_kg_per_kg_output NUMERIC(10, 6) NOT NULL, -- kg of material required for 1 kg product
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_recipe_material UNIQUE (recipe_id, material_id)
);

-- ==============================================================================
-- 6. CUSTOMER ORDERS (ORDER-DRIVEN PRODUCTION)
-- ==============================================================================

CREATE TABLE customer_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    order_number TEXT NOT NULL, -- e.g., 'ORD-20261011-001'
    order_date DATE NOT NULL DEFAULT CURRENT_DATE,
    required_delivery_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
        'draft', 'confirmed', 'in_production', 'partially_produced', 
        'produced', 'partially_dispatched', 'completed', 'cancelled'
    )),
    total_requested_weight_kg NUMERIC(14, 4) NOT NULL DEFAULT 0.0000,
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_order_tenant_number UNIQUE (tenant_id, order_number)
);

CREATE TABLE customer_order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    requested_quantity_kg NUMERIC(14, 4) NOT NULL CHECK (requested_quantity_kg > 0),
    planned_quantity_kg NUMERIC(14, 4) NOT NULL DEFAULT 0.0000,
    produced_quantity_kg NUMERIC(14, 4) NOT NULL DEFAULT 0.0000,
    dispatched_quantity_kg NUMERIC(14, 4) NOT NULL DEFAULT 0.0000,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_production', 'produced', 'partially_dispatched', 'dispatched')),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_order_product_item UNIQUE (order_id, product_id)
);

-- ==============================================================================
-- 7. PRODUCTION BATCHES & CONSUMPTION
-- ==============================================================================

CREATE TABLE production_batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES customer_orders(id) ON DELETE RESTRICT,
    order_item_id UUID NOT NULL REFERENCES customer_order_items(id) ON DELETE RESTRICT,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    recipe_id UUID NOT NULL REFERENCES product_recipes(id) ON DELETE RESTRICT,
    batch_number TEXT NOT NULL, -- e.g., 'PB-20261011-001'
    planned_quantity_kg NUMERIC(14, 4) NOT NULL CHECK (planned_quantity_kg > 0),
    actual_input_kg NUMERIC(14, 4) NOT NULL DEFAULT 0.0000,
    accepted_output_kg NUMERIC(14, 4) NOT NULL DEFAULT 0.0000,
    waste_kg NUMERIC(14, 4) NOT NULL DEFAULT 0.0000,
    rejected_kg NUMERIC(14, 4) NOT NULL DEFAULT 0.0000,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_progress', 'completed', 'cancelled')),
    operator_id UUID REFERENCES users(id),
    supervisor_id UUID REFERENCES users(id),
    start_time TIMESTAMP WITH TIME ZONE,
    completion_time TIMESTAMP WITH TIME ZONE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_prod_batch_tenant_number UNIQUE (tenant_id, batch_number)
);

CREATE TABLE production_material_consumption (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    production_batch_id UUID NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
    material_id UUID NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,
    material_batch_id UUID NOT NULL REFERENCES material_batches(id) ON DELETE RESTRICT,
    planned_quantity_kg NUMERIC(14, 4) NOT NULL DEFAULT 0.0000,
    actual_quantity_kg NUMERIC(14, 4) NOT NULL CHECK (actual_quantity_kg >= 0),
    consumed_by UUID REFERENCES users(id),
    consumed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    notes TEXT
);

CREATE TABLE production_outputs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    production_batch_id UUID NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
    accepted_kg NUMERIC(14, 4) NOT NULL CHECK (accepted_kg >= 0),
    waste_kg NUMERIC(14, 4) NOT NULL DEFAULT 0.0000 CHECK (waste_kg >= 0),
    rejected_kg NUMERIC(14, 4) NOT NULL DEFAULT 0.0000 CHECK (rejected_kg >= 0),
    recorded_by UUID REFERENCES users(id),
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    notes TEXT
);

-- ==============================================================================
-- 8. FINISHED GOODS INVENTORY
-- ==============================================================================

CREATE TABLE finished_goods_batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    production_batch_id UUID NOT NULL REFERENCES production_batches(id) ON DELETE RESTRICT,
    batch_number TEXT NOT NULL, -- usually matching or derived from production batch
    quantity_produced_kg NUMERIC(14, 4) NOT NULL CHECK (quantity_produced_kg > 0),
    quantity_on_hand_kg NUMERIC(14, 4) NOT NULL CHECK (quantity_on_hand_kg >= 0),
    quantity_reserved_kg NUMERIC(14, 4) NOT NULL DEFAULT 0.0000 CHECK (quantity_reserved_kg >= 0),
    quantity_dispatched_kg NUMERIC(14, 4) NOT NULL DEFAULT 0.0000 CHECK (quantity_dispatched_kg >= 0),
    status TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock', 'partially_dispatched', 'depleted')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_fg_batch_tenant_number UNIQUE (tenant_id, batch_number)
);

-- ==============================================================================
-- 9. DISPATCH & DELIVERIES
-- ==============================================================================

CREATE TABLE deliveries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    order_id UUID NOT NULL REFERENCES customer_orders(id) ON DELETE RESTRICT,
    delivery_number TEXT NOT NULL, -- e.g., 'DEL-20261011-001'
    dispatch_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    destination_address TEXT NOT NULL,
    vehicle_number TEXT,
    responsible_employee_id UUID REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'delivered', 'cancelled')),
    confirmed_by UUID REFERENCES users(id),
    confirmed_at TIMESTAMP WITH TIME ZONE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_delivery_tenant_number UNIQUE (tenant_id, delivery_number)
);

CREATE TABLE delivery_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    order_item_id UUID NOT NULL REFERENCES customer_order_items(id) ON DELETE RESTRICT,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity_kg NUMERIC(14, 4) NOT NULL CHECK (quantity_kg > 0),
    notes TEXT
);

CREATE TABLE delivery_batch_allocations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    delivery_item_id UUID NOT NULL REFERENCES delivery_items(id) ON DELETE CASCADE,
    finished_goods_batch_id UUID NOT NULL REFERENCES finished_goods_batches(id) ON DELETE RESTRICT,
    allocated_quantity_kg NUMERIC(14, 4) NOT NULL CHECK (allocated_quantity_kg > 0)
);

-- ==============================================================================
-- 10. UNIFIED INVENTORY LEDGER & AUDIT TRAILS
-- ==============================================================================

CREATE TABLE inventory_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    transaction_type TEXT NOT NULL CHECK (transaction_type IN (
        'receipt', 'consumption', 'production_output', 
        'dispatch', 'adjustment', 'return', 'write_off'
    )),
    item_type TEXT NOT NULL CHECK (item_type IN ('raw_material', 'finished_goods')),
    material_id UUID REFERENCES materials(id),
    material_batch_id UUID REFERENCES material_batches(id),
    product_id UUID REFERENCES products(id),
    finished_goods_batch_id UUID REFERENCES finished_goods_batches(id),
    quantity_kg NUMERIC(14, 4) NOT NULL, -- Positive for additions, negative for deductions
    reference_type TEXT NOT NULL, -- 'supplier_receipt', 'production_batch', 'delivery', 'adjustment'
    reference_id UUID NOT NULL,
    reason TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    action TEXT NOT NULL, -- 'CREATE', 'UPDATE', 'CONFIRM_PRODUCTION', 'CONFIRM_DISPATCH', 'CANCEL'
    entity_name TEXT NOT NULL,
    entity_id UUID NOT NULL,
    old_values JSONB,
    new_values JSONB,
    ip_address TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE attachments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL, -- 'material_batch', 'order', 'delivery', 'production_batch'
    entity_id UUID NOT NULL,
    file_name TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_size_bytes BIGINT,
    mime_type TEXT,
    uploaded_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ==============================================================================
-- 11. INDEXES FOR HIGH-PERFORMANCE MULTI-TENANT QUERYING
-- ==============================================================================

CREATE INDEX idx_users_tenant_email ON users(tenant_id, email);
CREATE INDEX idx_materials_tenant ON materials(tenant_id);
CREATE INDEX idx_material_batches_tenant ON material_batches(tenant_id, status);
CREATE INDEX idx_material_batches_material ON material_batches(material_id, remaining_quantity_kg);
CREATE INDEX idx_products_tenant ON products(tenant_id);
CREATE INDEX idx_recipes_tenant_prod ON product_recipes(tenant_id, product_id, is_active);
CREATE INDEX idx_orders_tenant_status ON customer_orders(tenant_id, status);
CREATE INDEX idx_prod_batches_tenant_status ON production_batches(tenant_id, status);
CREATE INDEX idx_prod_consumption_batch ON production_material_consumption(production_batch_id);
CREATE INDEX idx_fg_batches_tenant_status ON finished_goods_batches(tenant_id, status);
CREATE INDEX idx_deliveries_tenant_status ON deliveries(tenant_id, status);
CREATE INDEX idx_inv_tx_tenant_date ON inventory_transactions(tenant_id, created_at DESC);
CREATE INDEX idx_inv_tx_material_batch ON inventory_transactions(material_batch_id);
CREATE INDEX idx_inv_tx_fg_batch ON inventory_transactions(finished_goods_batch_id);
CREATE INDEX idx_audit_tenant_date ON audit_logs(tenant_id, created_at DESC);

-- ==============================================================================
-- 12. ROW LEVEL SECURITY (RLS) POLICIES
-- ==============================================================================

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_recipe_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_material_consumption ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE finished_goods_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_batch_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;

-- Dynamic RLS tenant context function:
-- Reads tenant_id from JWT app metadata or PostgreSQL session variable
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID AS $$
BEGIN
    RETURN COALESCE(
        NULLIF(current_setting('app.current_tenant_id', true), '')::UUID,
        (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')::UUID
    );
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- Generic RLS Policy application
DO $$
DECLARE
    tbl text;
BEGIN
    FOR tbl IN 
        SELECT tablename FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename IN (
            'tenant_settings', 'suppliers', 'materials', 'material_batches',
            'customers', 'products', 'product_recipes', 'customer_orders',
            'production_batches', 'production_material_consumption', 'production_outputs',
            'finished_goods_batches', 'deliveries', 'inventory_transactions',
            'audit_logs', 'attachments'
        )
    LOOP
        EXECUTE format('
            CREATE POLICY tenant_isolation_%I ON %I
            AS RESTRICTIVE
            USING (tenant_id = current_tenant_id() OR current_tenant_id() IS NULL)
            WITH CHECK (tenant_id = current_tenant_id() OR current_tenant_id() IS NULL);
        ', tbl, tbl);
    END LOOP;
END $$;

-- ==============================================================================
-- 13. SEED DATA (SINGLE FACTORY TENANT & SINGLE ADMIN USER ONLY)
-- ==============================================================================

DO $$
DECLARE
    v_tenant_id UUID;
    v_admin_id UUID;
    -- Argon2 hash for default password 'Admin@123'
    v_admin_pwd TEXT := '$argon2id$v=19$m=65536,t=3,p=4$7iPVXi9jH1y7+Jtb5AeoGg$+7a/XNpXGgEcy6B47mh8Q8iqq7a8q/f8+YjMzjJj2XA';
BEGIN
    -- 1. Insert Single Factory Tenant
    INSERT INTO tenants (tenant_id, name, status, address, contact_email, contact_phone)
    VALUES ('shri-hari-pack', 'Shri Hari Packaging Factory', 'active', 'Plot 45, GIDC Industrial Estate, Vapi, Gujarat', 'info@shriharipackaging.com', '+91 98765 43210')
    RETURNING id INTO v_tenant_id;

    -- Tenant settings
    INSERT INTO tenant_settings (tenant_id, standard_weight_unit, allow_negative_stock, min_stock_alert_enabled, suggest_fifo_batch_allocation)
    VALUES (v_tenant_id, 'kg', FALSE, TRUE, TRUE);

    -- 2. Insert Single Admin User (admin@shrihari.com / Admin@123)
    INSERT INTO users (email, password_hash, full_name, phone, role, tenant_id)
    VALUES 
    ('admin@shrihari.com', v_admin_pwd, 'Factory Admin', '+91 98200 11223', 'factory_admin', v_tenant_id)
    RETURNING id INTO v_admin_id;

END $$;
