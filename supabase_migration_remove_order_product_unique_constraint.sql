-- Migration: Allow multiple line items of the same product with different sizes/microns in customer_orders
-- Fixes error: duplicate key value violates unique constraint "uq_order_product_item"

ALTER TABLE public.customer_order_items DROP CONSTRAINT IF EXISTS uq_order_product_item;

