-- ==============================================================================
-- SHRI HARI PACKAGING ERP - SIZE & MICRON MASTER MIGRATION SCRIPT
-- ==============================================================================
-- Project Ref: rahhovvfcekzezhxunfa
-- Run this in your Supabase Dashboard SQL Editor:
-- https://supabase.com/dashboard/project/rahhovvfcekzezhxunfa/sql/new
-- ==============================================================================

-- 1. Create size_microns Master Table
CREATE TABLE IF NOT EXISTS public.size_microns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    label TEXT NOT NULL,
    size TEXT DEFAULT 'Standard',
    micron NUMERIC(10, 2) NOT NULL,
    unit TEXT NOT NULL DEFAULT 'Micron',
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for tenant queries
CREATE INDEX IF NOT EXISTS idx_size_microns_tenant ON public.size_microns(tenant_id);

-- 2. Add size_micron & grade columns to products & orders tables
ALTER TABLE IF EXISTS public.products ADD COLUMN IF NOT EXISTS size_micron TEXT;
ALTER TABLE IF EXISTS public.customer_orders ADD COLUMN IF NOT EXISTS size_micron TEXT;
ALTER TABLE IF EXISTS public.customer_orders ADD COLUMN IF NOT EXISTS grade TEXT;
ALTER TABLE IF EXISTS public.customer_order_items ADD COLUMN IF NOT EXISTS size_micron TEXT;
ALTER TABLE IF EXISTS public.customer_order_items ADD COLUMN IF NOT EXISTS grade TEXT;

-- 3. Enable RLS (Row Level Security) and allow full access for authenticated users & service role
ALTER TABLE public.size_microns ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'size_microns' AND policyname = 'Allow all operations on size_microns'
    ) THEN
        CREATE POLICY "Allow all operations on size_microns" 
        ON public.size_microns 
        FOR ALL 
        USING (true) 
        WITH CHECK (true);
    END IF;
END $$;
