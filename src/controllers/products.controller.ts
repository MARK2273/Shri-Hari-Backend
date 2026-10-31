import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { z } from 'zod';
import crypto from 'crypto';
import { inMemMaterials, inMemBatches } from './materials.controller';

interface InMemRecipeItem {
  id: string;
  recipe_id: string;
  material_id: string;
  plate_type?: 'A' | 'B' | 'C' | string;
  plate_a_kg?: number;
  plate_b_kg?: number;
  plate_c_kg?: number;
  quantity_kg?: number;
  percentage: number;
  planned_kg_per_kg_output: number;
  materials?: any;
}

export const computePlateSummary = (
  plateAOrItems?: any,
  plateB?: number,
  plateC?: number,
  totalBatchKg?: number,
  orderKg: number = 0
) => {
  // If first argument is an array of items (polymer-wise items)
  if (Array.isArray(plateAOrItems)) {
    const items = plateAOrItems;
    const hasPerItemPlates = items.some((it: any) => 
      Number(it.plate_a_kg || 0) > 0 || Number(it.plate_b_kg || 0) > 0 || Number(it.plate_c_kg || 0)
    );

    let aKg = 0;
    let bKg = 0;
    let cKg = 0;
    let countA = 0;
    let countB = 0;
    let countC = 0;

    if (hasPerItemPlates) {
      items.forEach((it: any) => {
        const a = Number(it.plate_a_kg || 0);
        const b = Number(it.plate_b_kg || 0);
        const c = Number(it.plate_c_kg || 0);
        if (a > 0) { aKg += a; countA++; }
        if (b > 0) { bKg += b; countB++; }
        if (c > 0) { cKg += c; countC++; }
      });
    } else {
      items.forEach((it: any) => {
        const rawPlate = (it.plate_type || 'A').toUpperCase();
        const kg = Number(it.quantity_kg ?? it.percentage) || 0;
        if (rawPlate === 'B') { bKg += kg; countB++; }
        else if (rawPlate === 'C') { cKg += kg; countC++; }
        else { aKg += kg; countA++; }
      });
    }

    aKg = Number(aKg.toFixed(3));
    bKg = Number(bKg.toFixed(3));
    cKg = Number(cKg.toFixed(3));
    const total = Number((aKg + bKg + cKg).toFixed(3)) || 1;
    const aPct = Number(((aKg / total) * 100).toFixed(1));
    const bPct = Number(((bKg / total) * 100).toFixed(1));
    const cPct = Number(((cKg / total) * 100).toFixed(1));

    const aFeed = orderKg > 0 ? Number((orderKg * (aPct / 100)).toFixed(2)) : aKg;
    const bFeed = orderKg > 0 ? Number((orderKg * (bPct / 100)).toFixed(2)) : bKg;
    const cFeed = orderKg > 0 ? Number((orderKg * (cPct / 100)).toFixed(2)) : cKg;

    return {
      A: { total_kg: aKg, recipe_kg: aKg, total_recipe_kg: aKg, percentage: aPct, feed_kg: aFeed, required_kg: aFeed, count: countA },
      B: { total_kg: bKg, recipe_kg: bKg, total_recipe_kg: bKg, percentage: bPct, feed_kg: bFeed, required_kg: bFeed, count: countB },
      C: { total_kg: cKg, recipe_kg: cKg, total_recipe_kg: cKg, percentage: cPct, feed_kg: cFeed, required_kg: cFeed, count: countC },
      total_batch_kg: total,
      total_plate_kg: total,
      is_balanced: true,
    };
  }

  // Otherwise, plateA, plateB, plateC are direct numbers
  let aKg = Number(plateAOrItems) || 0;
  let bKg = Number(plateB) || 0;
  let cKg = Number(plateC) || 0;
  let total = Number(totalBatchKg) || 0;

  if (aKg === 0 && bKg === 0 && cKg === 0) {
    total = total > 0 ? total : 150;
    aKg = Number((total * 0.4).toFixed(2));
    bKg = Number((total * (40 / 150)).toFixed(2));
    cKg = Number((total - aKg - bKg).toFixed(2));
  } else if (total <= 0) {
    total = aKg + bKg + cKg;
  }

  const plateSum = Number((aKg + bKg + cKg).toFixed(2));
  const calcTotal = total > 0 ? total : (plateSum > 0 ? plateSum : 150);

  const aPct = calcTotal > 0 ? Number(((aKg / calcTotal) * 100).toFixed(1)) : 0;
  const bPct = calcTotal > 0 ? Number(((bKg / calcTotal) * 100).toFixed(1)) : 0;
  const cPct = calcTotal > 0 ? Number(((cKg / calcTotal) * 100).toFixed(1)) : 0;

  const aFeed = orderKg > 0 ? Number((orderKg * (aPct / 100)).toFixed(2)) : aKg;
  const bFeed = orderKg > 0 ? Number((orderKg * (bPct / 100)).toFixed(2)) : bKg;
  const cFeed = orderKg > 0 ? Number((orderKg * (cPct / 100)).toFixed(2)) : cKg;

  return {
    A: { total_kg: aKg, recipe_kg: aKg, total_recipe_kg: aKg, percentage: aPct, feed_kg: aFeed, required_kg: aFeed, count: 1 },
    B: { total_kg: bKg, recipe_kg: bKg, total_recipe_kg: bKg, percentage: bPct, feed_kg: bFeed, required_kg: bFeed, count: 1 },
    C: { total_kg: cKg, recipe_kg: cKg, total_recipe_kg: cKg, percentage: cPct, feed_kg: cFeed, required_kg: cFeed, count: 1 },
    total_batch_kg: calcTotal,
    total_plate_kg: plateSum,
    is_balanced: Math.abs(plateSum - calcTotal) < 0.05,
  };
};

interface InMemRecipe {
  id: string;
  tenant_id: string;
  product_id: string;
  version: number;
  is_active: boolean;
  notes?: string;
  created_by?: string;
  effective_date: string;
  plate_a_kg?: number;
  plate_b_kg?: number;
  plate_c_kg?: number;
  total_batch_kg?: number;
  product_recipe_items: InMemRecipeItem[];
}

interface InMemProduct {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  description?: string;
  unit: string;
  standard_weight_kg: number;
  size_micron?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  product_recipes: InMemRecipe[];
}

import { mockStore, saveMockStore } from '../utils/mockStore';

export let inMemProducts: InMemProduct[] = mockStore.products;

const getTenantId = (req: Request): string => (req.tenantId || process.env.DEFAULT_TENANT_SLUG || 'shri-hari-pack') as string;

// List products with active recipes (PRD-01)
export const getProducts = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);

    if (!isSupabaseConfigured) {
      const tenantProducts = inMemProducts.filter((p) => p.tenant_id === tenantId);
      const costAgg: Record<string, { totalVal: number; totalQty: number }> = {};
      inMemBatches.forEach((b: any) => {
        const cost = Number(b.cost_per_kg) || 0;
        const qty = Number(b.remaining_quantity_kg) || Number(b.received_quantity_kg) || 0;
        if (cost > 0 && qty > 0) {
          if (!costAgg[b.material_id]) costAgg[b.material_id] = { totalVal: 0, totalQty: 0 };
          costAgg[b.material_id].totalVal += cost * qty;
          costAgg[b.material_id].totalQty += qty;
        }
      });
      const costMap: Record<string, number> = {};
      Object.keys(costAgg).forEach((mId) => {
        costMap[mId] = costAgg[mId].totalQty > 0 ? costAgg[mId].totalVal / costAgg[mId].totalQty : 0;
      });

      const enriched = tenantProducts.map((p) => {
        const recipes = p.product_recipes || [];
        const activeRecipe = recipes.find((r) => r.is_active) || recipes[0] || null;
        let recipeCost = 0;
        if (activeRecipe?.product_recipe_items) {
          recipeCost = activeRecipe.product_recipe_items.reduce((sum: number, it: any) => {
            const cost = costMap[it.material_id] || 0;
            const ratio = Number(it.planned_kg_per_kg_output) || ((Number(it.percentage) || 0) / 100);
            return sum + ratio * cost;
          }, 0);
        }
        return {
          ...p,
          recipe_cost_per_kg: Number(recipeCost.toFixed(2)),
          active_recipe: activeRecipe
            ? {
                ...activeRecipe,
                recipe_cost_per_kg: Number(recipeCost.toFixed(2)),
                plate_summary: computePlateSummary(
                  activeRecipe.plate_a_kg,
                  activeRecipe.plate_b_kg,
                  activeRecipe.plate_c_kg,
                  activeRecipe.total_batch_kg
                ),
              }
            : null,
        };
      });
      return res.json({ success: true, products: enriched });
    }

    const { data: products, error } = await supabase
      .from('products')
      .select(`
        *,
        product_recipes (
          id, version, is_active, notes, effective_date, plate_a_kg, plate_b_kg, plate_c_kg, total_batch_kg,
          product_recipe_items (
            id, material_id, plate_type, plate_a_kg, plate_b_kg, plate_c_kg, quantity_kg, percentage, planned_kg_per_kg_output,
            materials (id, code, name, standard_unit)
          )
        )
      `)
      .eq('tenant_id', tenantId)
      .order('code', { ascending: true });

    if (error) throw error;

    // Fetch batch costs to calculate recipe formulation cost using weighted average
    const { data: batches } = await supabase
      .from('material_batches')
      .select('material_id, remaining_quantity_kg, received_quantity_kg, cost_per_kg')
      .eq('tenant_id', tenantId)
      .gt('cost_per_kg', 0);

    const costAgg: Record<string, { totalVal: number; totalQty: number }> = {};
    (batches || []).forEach((b: any) => {
      const cost = Number(b.cost_per_kg) || 0;
      const qty = Number(b.remaining_quantity_kg) || Number(b.received_quantity_kg) || 0;
      if (cost > 0 && qty > 0) {
        if (!costAgg[b.material_id]) costAgg[b.material_id] = { totalVal: 0, totalQty: 0 };
        costAgg[b.material_id].totalVal += cost * qty;
        costAgg[b.material_id].totalQty += qty;
      }
    });

    const costMap: Record<string, number> = {};
    Object.keys(costAgg).forEach((mId) => {
      costMap[mId] = costAgg[mId].totalQty > 0 ? costAgg[mId].totalVal / costAgg[mId].totalQty : 0;
    });

    // Map to include latest active recipe and calculated formulation cost
    const enriched = products.map((p: any) => {
      const activeRecipe = (p.product_recipes || []).find((r: any) => r.is_active) || p.product_recipes?.[0] || null;
      let recipeCost = 0;
      if (activeRecipe?.product_recipe_items) {
        recipeCost = activeRecipe.product_recipe_items.reduce((sum: number, it: any) => {
          const cost = costMap[it.material_id] || 0;
          const ratio = Number(it.planned_kg_per_kg_output) || ((Number(it.percentage) || 0) / 100);
          return sum + ratio * cost;
        }, 0);
      }
      return {
        ...p,
        recipe_cost_per_kg: Number(recipeCost.toFixed(2)),
        active_recipe: activeRecipe
          ? {
              ...activeRecipe,
              recipe_cost_per_kg: Number(recipeCost.toFixed(2)),
              plate_summary: computePlateSummary(
                activeRecipe.product_recipe_items || activeRecipe.plate_a_kg,
                activeRecipe.plate_b_kg,
                activeRecipe.plate_c_kg,
                activeRecipe.total_batch_kg
              ),
            }
          : null,
      };
    });

    return res.json({ success: true, products: enriched });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Create Product (Auto-generates PRD-XXXX code if not provided)
export const createProduct = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = req.user?.id;

    const schema = z.object({
      code: z.string().optional(),
      name: z.string().min(2),
      description: z.string().optional(),
      unit: z.enum(['kg', 'pcs', 'rolls']).default('kg'),
      standardWeightKg: z.number().positive().default(1.0),
      sizeMicron: z.string().optional(),
      initialRecipe: z.object({
        notes: z.string().optional(),
        plateA_kg: z.coerce.number().min(0).optional(),
        plateB_kg: z.coerce.number().min(0).optional(),
        plateC_kg: z.coerce.number().min(0).optional(),
        plate_a_kg: z.coerce.number().min(0).optional(),
        plate_b_kg: z.coerce.number().min(0).optional(),
        plate_c_kg: z.coerce.number().min(0).optional(),
        totalBatchKg: z.coerce.number().min(0).optional(),
        total_batch_kg: z.coerce.number().min(0).optional(),
        items: z.array(z.object({
          materialId: z.string().min(1),
          plateType: z.string().optional(),
          plate_type: z.string().optional(),
          plateA_kg: z.coerce.number().min(0).optional(),
          plateB_kg: z.coerce.number().min(0).optional(),
          plateC_kg: z.coerce.number().min(0).optional(),
          plate_a_kg: z.coerce.number().min(0).optional(),
          plate_b_kg: z.coerce.number().min(0).optional(),
          plate_c_kg: z.coerce.number().min(0).optional(),
          quantityKg: z.coerce.number().min(0).optional(),
          percentage: z.coerce.number().min(0).optional(),
          plannedKgPerKgOutput: z.coerce.number().min(0).optional(),
        })).min(1),
      }).optional(),
    });

    const body = schema.parse(req.body);
    const generatedCode = body.code ? body.code.toUpperCase() : `PRD-${Math.floor(Math.random() * 9000 + 1000)}`;

    let calculatedPlateA = 0;
    let calculatedPlateB = 0;
    let calculatedPlateC = 0;
    let calculatedTotalKg = 0;

    if (body.initialRecipe && body.initialRecipe.items && body.initialRecipe.items.length > 0) {
      body.initialRecipe.items.forEach((it) => {
        const a = Number(it.plateA_kg ?? it.plate_a_kg ?? 0);
        const b = Number(it.plateB_kg ?? it.plate_b_kg ?? 0);
        const c = Number(it.plateC_kg ?? it.plate_c_kg ?? 0);
        calculatedPlateA += a;
        calculatedPlateB += b;
        calculatedPlateC += c;
        const total = (a + b + c > 0) ? (a + b + c) : (Number(it.quantityKg ?? it.percentage) || 0);
        calculatedTotalKg += total;
      });

      const hasItemPlates = (calculatedPlateA > 0 || calculatedPlateB > 0 || calculatedPlateC > 0);
      if (!hasItemPlates) {
        calculatedPlateA = Number(body.initialRecipe.plateA_kg ?? body.initialRecipe.plate_a_kg ?? 0);
        calculatedPlateB = Number(body.initialRecipe.plateB_kg ?? body.initialRecipe.plate_b_kg ?? 0);
        calculatedPlateC = Number(body.initialRecipe.plateC_kg ?? body.initialRecipe.plate_c_kg ?? 0);
      }

      calculatedPlateA = Number(calculatedPlateA.toFixed(3));
      calculatedPlateB = Number(calculatedPlateB.toFixed(3));
      calculatedPlateC = Number(calculatedPlateC.toFixed(3));
      calculatedTotalKg = Number((calculatedTotalKg > 0 ? calculatedTotalKg : (calculatedPlateA + calculatedPlateB + calculatedPlateC)).toFixed(3));
    }

    if (!isSupabaseConfigured) {
      const newProductId = crypto.randomUUID();
      const newRecipeId = crypto.randomUUID();

      let initialRecipes: InMemRecipe[] = [];
      if (body.initialRecipe) {
        const batchKg = calculatedTotalKg || 1;

        const recipeItems: InMemRecipeItem[] = body.initialRecipe.items.map((i) => {
          const mat = inMemMaterials.find((m) => m.id === i.materialId);
          const a = Number(i.plateA_kg ?? i.plate_a_kg ?? 0);
          const b = Number(i.plateB_kg ?? i.plate_b_kg ?? 0);
          const c = Number(i.plateC_kg ?? i.plate_c_kg ?? 0);
          const itemKg = (a + b + c > 0) ? (a + b + c) : (Number(i.quantityKg ?? i.percentage) || 0);
          const ratio = batchKg > 0 ? (itemKg / batchKg) : 0;
          const plannedPerKg = Number((i.plannedKgPerKgOutput ?? ratio).toFixed(6));
          const pct = Number((ratio * 100).toFixed(3));
          const rawPlate = (i.plateType || i.plate_type || (a > 0 ? 'A' : (b > 0 ? 'B' : 'C'))).toUpperCase();

          return {
            id: crypto.randomUUID(),
            recipe_id: newRecipeId,
            material_id: i.materialId,
            plate_type: rawPlate,
            plate_a_kg: a,
            plate_b_kg: b,
            plate_c_kg: c,
            quantity_kg: itemKg,
            percentage: pct,
            planned_kg_per_kg_output: plannedPerKg,
            materials: mat ? { id: mat.id, code: mat.code, name: mat.name, standard_unit: mat.standard_unit } : undefined,
          };
        });

        initialRecipes = [
          {
            id: newRecipeId,
            tenant_id: tenantId,
            product_id: newProductId,
            version: 1,
            is_active: true,
            notes: body.initialRecipe.notes || 'Initial product BOM formulation',
            created_by: userId,
            effective_date: new Date().toISOString(),
            plate_a_kg: calculatedPlateA,
            plate_b_kg: calculatedPlateB,
            plate_c_kg: calculatedPlateC,
            total_batch_kg: batchKg,
            product_recipe_items: recipeItems,
          },
        ];
      }

      const newProduct: InMemProduct = {
        id: newProductId,
        tenant_id: tenantId,
        code: generatedCode,
        name: body.name.trim(),
        description: body.description?.trim() || '',
        unit: body.unit,
        standard_weight_kg: body.standardWeightKg,
        size_micron: body.sizeMicron?.trim() || '',
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        product_recipes: initialRecipes,
      };

      inMemProducts.push(newProduct);
      saveMockStore();
      return res.status(201).json({
        success: true,
        product: { ...newProduct, active_recipe: initialRecipes[0] || null },
      });
    }

    // Supabase mode:
    // 1. Create product
    const { data: product, error: prdError } = await supabase
      .from('products')
      .insert({
        tenant_id: tenantId,
        code: generatedCode,
        name: body.name.trim(),
        description: body.description,
        unit: body.unit,
        standard_weight_kg: body.standardWeightKg,
        size_micron: body.sizeMicron?.trim() || null,
      })
      .select('*')
      .single();

    if (prdError) throw prdError;

    // 2. Create version 1 recipe if supplied
    if (body.initialRecipe) {
      const batchKg = calculatedTotalKg || 1;

      const { data: recipe, error: recError } = await supabase
        .from('product_recipes')
        .insert({
          tenant_id: tenantId,
          product_id: product.id,
          version: 1,
          is_active: true,
          notes: body.initialRecipe.notes,
          created_by: userId,
          plate_a_kg: calculatedPlateA,
          plate_b_kg: calculatedPlateB,
          plate_c_kg: calculatedPlateC,
          total_batch_kg: batchKg,
        })
        .select('*')
        .single();

      if (recError) throw recError;

      const items = body.initialRecipe.items.map((item) => {
        const a = Number(item.plateA_kg ?? item.plate_a_kg ?? 0);
        const b = Number(item.plateB_kg ?? item.plate_b_kg ?? 0);
        const c = Number(item.plateC_kg ?? item.plate_c_kg ?? 0);
        const itemKg = (a + b + c > 0) ? (a + b + c) : (Number(item.quantityKg ?? item.percentage) || 0);
        const ratio = batchKg > 0 ? (itemKg / batchKg) : 0;
        const plannedPerKg = Number((item.plannedKgPerKgOutput ?? ratio).toFixed(6));
        const pct = Number((ratio * 100).toFixed(3));
        const rawPlate = (item.plateType || item.plate_type || (a > 0 ? 'A' : (b > 0 ? 'B' : 'C'))).toUpperCase();

        return {
          recipe_id: recipe.id,
          material_id: item.materialId,
          plate_type: rawPlate,
          plate_a_kg: a,
          plate_b_kg: b,
          plate_c_kg: c,
          quantity_kg: itemKg,
          percentage: pct,
          planned_kg_per_kg_output: plannedPerKg,
        };
      });

      await supabase.from('product_recipe_items').insert(items);
    }

    return res.status(201).json({ success: true, product });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      const msg = error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join(', ');
      return res.status(400).json({ success: false, message: msg, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Update Product
export const updateProduct = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;

    const schema = z.object({
      name: z.string().min(2).optional(),
      description: z.string().optional(),
      unit: z.enum(['kg', 'pcs', 'rolls']).optional(),
      standardWeightKg: z.number().positive().optional(),
      sizeMicron: z.string().optional(),
      isActive: z.boolean().optional(),
    });

    const body = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      const idx = inMemProducts.findIndex((p) => p.tenant_id === tenantId && p.id === id);
      if (idx === -1) {
        return res.status(404).json({ success: false, message: 'Product not found' });
      }

      inMemProducts[idx] = {
        ...inMemProducts[idx],
        ...(body.name ? { name: body.name.trim() } : {}),
        ...(body.description !== undefined ? { description: body.description.trim() } : {}),
        ...(body.unit ? { unit: body.unit } : {}),
        ...(body.standardWeightKg !== undefined ? { standard_weight_kg: body.standardWeightKg } : {}),
        ...(body.sizeMicron !== undefined ? { size_micron: body.sizeMicron.trim() } : {}),
        ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
        updated_at: new Date().toISOString(),
      };

      saveMockStore();

      return res.json({ success: true, product: inMemProducts[idx] });
    }

    const updates: any = { updated_at: new Date().toISOString() };
    if (body.name) updates.name = body.name.trim();
    if (body.description !== undefined) updates.description = body.description;
    if (body.unit) updates.unit = body.unit;
    if (body.standardWeightKg !== undefined) updates.standard_weight_kg = body.standardWeightKg;
    if (body.sizeMicron !== undefined) updates.size_micron = body.sizeMicron.trim();
    if (body.isActive !== undefined) updates.is_active = body.isActive;

    const { data, error } = await supabase
      .from('products')
      .update(updates)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ success: true, product: data });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Delete Product
export const deleteProduct = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;

    if (!isSupabaseConfigured) {
      const initialLen = inMemProducts.length;
      inMemProducts = inMemProducts.filter((p) => !(p.tenant_id === tenantId && p.id === id));
      if (inMemProducts.length === initialLen) {
        return res.status(404).json({ success: false, message: 'Product not found' });
      }
      return res.json({ success: true, message: 'Product deleted successfully' });
    }

    // Delete child recipe items and recipes first if needed
    const { data: recipes } = await supabase
      .from('product_recipes')
      .select('id')
      .eq('product_id', id)
      .eq('tenant_id', tenantId);

    if (recipes && recipes.length > 0) {
      const recIds = recipes.map((r: any) => r.id);
      await supabase.from('product_recipe_items').delete().in('recipe_id', recIds);
      await supabase.from('product_recipes').delete().eq('product_id', id).eq('tenant_id', tenantId);
    }

    const { error } = await supabase
      .from('products')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (error) throw error;
    return res.json({ success: true, message: 'Product deleted successfully' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Create a new version of a recipe (PRD-04: Versioning preserved)
export const addRecipeVersion = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = req.user?.id;
    const { productId } = req.params;

    const schema = z.object({
      notes: z.string().optional(),
      plateA_kg: z.coerce.number().min(0).optional(),
      plateB_kg: z.coerce.number().min(0).optional(),
      plateC_kg: z.coerce.number().min(0).optional(),
      plate_a_kg: z.coerce.number().min(0).optional(),
      plate_b_kg: z.coerce.number().min(0).optional(),
      plate_c_kg: z.coerce.number().min(0).optional(),
      totalBatchKg: z.coerce.number().min(0).optional(),
      total_batch_kg: z.coerce.number().min(0).optional(),
        items: z.array(z.object({
          materialId: z.string().min(1),
          plateType: z.string().optional(),
          plate_type: z.string().optional(),
          plateA_kg: z.coerce.number().min(0).optional(),
          plateB_kg: z.coerce.number().min(0).optional(),
          plateC_kg: z.coerce.number().min(0).optional(),
          plate_a_kg: z.coerce.number().min(0).optional(),
          plate_b_kg: z.coerce.number().min(0).optional(),
          plate_c_kg: z.coerce.number().min(0).optional(),
          quantityKg: z.coerce.number().min(0).optional(),
          percentage: z.coerce.number().min(0).optional(),
          plannedKgPerKgOutput: z.coerce.number().min(0).optional(),
        })).min(1),
      });

      const body = schema.parse(req.body);

      let calculatedPlateA = 0;
      let calculatedPlateB = 0;
      let calculatedPlateC = 0;
      let calculatedTotalKg = 0;

      body.items.forEach((it) => {
        const a = Number(it.plateA_kg ?? it.plate_a_kg ?? 0);
        const b = Number(it.plateB_kg ?? it.plate_b_kg ?? 0);
        const c = Number(it.plateC_kg ?? it.plate_c_kg ?? 0);
        calculatedPlateA += a;
        calculatedPlateB += b;
        calculatedPlateC += c;
        const total = (a + b + c > 0) ? (a + b + c) : (Number(it.quantityKg ?? it.percentage) || 0);
        calculatedTotalKg += total;
      });

      const hasItemPlates = (calculatedPlateA > 0 || calculatedPlateB > 0 || calculatedPlateC > 0);
      if (!hasItemPlates) {
        calculatedPlateA = Number(body.plateA_kg ?? body.plate_a_kg ?? 0);
        calculatedPlateB = Number(body.plateB_kg ?? body.plate_b_kg ?? 0);
        calculatedPlateC = Number(body.plateC_kg ?? body.plate_c_kg ?? 0);
      }

      calculatedPlateA = Number(calculatedPlateA.toFixed(3));
      calculatedPlateB = Number(calculatedPlateB.toFixed(3));
      calculatedPlateC = Number(calculatedPlateC.toFixed(3));
      calculatedTotalKg = Number((calculatedTotalKg > 0 ? calculatedTotalKg : (calculatedPlateA + calculatedPlateB + calculatedPlateC)).toFixed(3));

      const batchKg = Number(body.totalBatchKg ?? body.total_batch_kg ?? calculatedTotalKg) || 1;

      if (!isSupabaseConfigured) {
        const product = inMemProducts.find((p) => p.tenant_id === tenantId && p.id === productId);
        if (!product) {
          return res.status(404).json({ success: false, message: 'Product not found' });
        }

        // Deactivate prior versions
        const currentRecipes = product.product_recipes || [];
        currentRecipes.forEach((r) => {
          r.is_active = false;
        });

        const nextVersion = currentRecipes.length + 1;
        const newRecId = crypto.randomUUID();

        const recipeItems: InMemRecipeItem[] = body.items.map((i) => {
          const mat = inMemMaterials.find((m) => m.id === i.materialId);
          const a = Number(i.plateA_kg ?? i.plate_a_kg ?? 0);
          const b = Number(i.plateB_kg ?? i.plate_b_kg ?? 0);
          const c = Number(i.plateC_kg ?? i.plate_c_kg ?? 0);
          const itemKg = (a + b + c > 0) ? (a + b + c) : (Number(i.quantityKg ?? i.percentage) || 0);
          const ratio = batchKg > 0 ? (itemKg / batchKg) : 0;
          const plannedPerKg = Number((i.plannedKgPerKgOutput ?? ratio).toFixed(6));
          const pct = Number((ratio * 100).toFixed(3));
          const rawPlate = (i.plateType || i.plate_type || (a > 0 ? 'A' : (b > 0 ? 'B' : 'C'))).toUpperCase();

          return {
            id: crypto.randomUUID(),
            recipe_id: newRecId,
            material_id: i.materialId,
            plate_type: rawPlate,
            plate_a_kg: a,
            plate_b_kg: b,
            plate_c_kg: c,
            quantity_kg: itemKg,
            percentage: pct,
            planned_kg_per_kg_output: plannedPerKg,
            materials: mat ? { id: mat.id, code: mat.code, name: mat.name, standard_unit: mat.standard_unit } : undefined,
          };
        });

        const newRecipe: InMemRecipe = {
          id: newRecId,
          tenant_id: tenantId,
          product_id: productId,
          version: nextVersion,
          is_active: true,
          notes: body.notes || `Recipe Version ${nextVersion}`,
          created_by: userId,
          effective_date: new Date().toISOString(),
          plate_a_kg: calculatedPlateA,
          plate_b_kg: calculatedPlateB,
          plate_c_kg: calculatedPlateC,
          total_batch_kg: batchKg,
          product_recipe_items: recipeItems,
        };

        currentRecipes.unshift(newRecipe);
        product.product_recipes = currentRecipes;

        return res.status(201).json({ success: true, recipe: newRecipe, version: nextVersion });
      }

      // Get max version
      const { data: existingRecipes } = await supabase
        .from('product_recipes')
        .select('version')
        .eq('product_id', productId)
        .eq('tenant_id', tenantId)
        .order('version', { ascending: false });

      const nextVersion = (existingRecipes?.[0]?.version || 0) + 1;

      // Deactivate prior versions
      await supabase
        .from('product_recipes')
        .update({ is_active: false })
        .eq('product_id', productId)
        .eq('tenant_id', tenantId);

      // Insert new version
      const { data: newRecipe, error: recError } = await supabase
        .from('product_recipes')
        .insert({
          tenant_id: tenantId,
          product_id: productId,
          version: nextVersion,
          is_active: true,
          notes: body.notes,
          created_by: userId,
          plate_a_kg: calculatedPlateA,
          plate_b_kg: calculatedPlateB,
          plate_c_kg: calculatedPlateC,
          total_batch_kg: batchKg,
        })
        .select('*')
        .single();

      if (recError) throw recError;

      const items = body.items.map((i) => {
        const a = Number(i.plateA_kg ?? i.plate_a_kg ?? 0);
        const b = Number(i.plateB_kg ?? i.plate_b_kg ?? 0);
        const c = Number(i.plateC_kg ?? i.plate_c_kg ?? 0);
        const itemKg = (a + b + c > 0) ? (a + b + c) : (Number(i.quantityKg ?? i.percentage) || 0);
        const ratio = batchKg > 0 ? (itemKg / batchKg) : 0;
        const plannedPerKg = Number((i.plannedKgPerKgOutput ?? ratio).toFixed(6));
        const pct = Number((ratio * 100).toFixed(3));
        const rawPlate = (i.plateType || i.plate_type || (a > 0 ? 'A' : (b > 0 ? 'B' : 'C'))).toUpperCase();

        return {
          recipe_id: newRecipe.id,
          material_id: i.materialId,
          plate_type: rawPlate,
          plate_a_kg: a,
          plate_b_kg: b,
          plate_c_kg: c,
          quantity_kg: itemKg,
          percentage: pct,
          planned_kg_per_kg_output: plannedPerKg,
        };
      });

      await supabase.from('product_recipe_items').insert(items);

    return res.status(201).json({ success: true, recipe: newRecipe, version: nextVersion });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      const msg = error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join(', ');
      return res.status(400).json({ success: false, message: msg, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

export interface MaterialRequirementDetail {
  material_id: string;
  material_code: string;
  material_name: string;
  plate_type?: 'A' | 'B' | 'C' | string;
  quantity_kg?: number;
  percentage: number;
  planned_kg_per_kg_output: number;
  required_kg: number;
  available_stock_kg: number;
  sufficient: boolean;
  suggested_batches?: any[];
}

export interface MaterialStockCheckResult {
  sufficient: boolean;
  all_sufficient: boolean;
  recipe_id?: string;
  product_id?: string;
  planned_quantity_kg: number;
  requirements: MaterialRequirementDetail[];
  plate_summary?: any;
  missingDetails?: string;
}

// Helper to check raw material stock feasibility for a product or recipe
export async function checkProductMaterialStock(
  tenantId: string,
  productId?: string,
  recipeId?: string,
  quantityKg: number = 0
): Promise<MaterialStockCheckResult> {
  const qty = Number(quantityKg);
  if (qty <= 0) {
    return {
      sufficient: true,
      all_sufficient: true,
      planned_quantity_kg: 0,
      requirements: [],
    };
  }

  const buildPlatesSummary = (reqs: MaterialRequirementDetail[]) => {
    const summary: Record<'A' | 'B' | 'C', { total_recipe_kg: number; required_kg: number; percentage: number }> = {
      A: { total_recipe_kg: 0, required_kg: 0, percentage: 0 },
      B: { total_recipe_kg: 0, required_kg: 0, percentage: 0 },
      C: { total_recipe_kg: 0, required_kg: 0, percentage: 0 },
    };

    reqs.forEach((r) => {
      const rawPlate = (r.plate_type || 'A').toUpperCase();
      const p = (rawPlate === 'B' || rawPlate === 'C' ? rawPlate : 'A') as 'A' | 'B' | 'C';
      summary[p].total_recipe_kg = Number((summary[p].total_recipe_kg + (r.quantity_kg || 0)).toFixed(2));
      summary[p].required_kg = Number((summary[p].required_kg + r.required_kg).toFixed(2));
    });

    const totalReq = Object.values(summary).reduce((acc, s) => acc + s.required_kg, 0) || 1;
    (['A', 'B', 'C'] as const).forEach((p) => {
      summary[p].percentage = Number(((summary[p].required_kg / totalReq) * 100).toFixed(1));
    });

    return summary;
  };

  if (!isSupabaseConfigured) {
    let foundRecipe: InMemRecipe | null = null;
    let resolvedProductId = productId;

    for (const p of inMemProducts) {
      if (p.tenant_id === tenantId) {
        if (recipeId) {
          const r = (p.product_recipes || []).find((rec) => rec.id === recipeId);
          if (r) {
            foundRecipe = r;
            resolvedProductId = p.id;
            break;
          }
        } else if (productId && p.id === productId) {
          foundRecipe = (p.product_recipes || []).find((rec) => rec.is_active) || (p.product_recipes || [])[0] || null;
          resolvedProductId = p.id;
          break;
        }
      }
    }

    if (!foundRecipe) {
      return {
        sufficient: true,
        all_sufficient: true,
        planned_quantity_kg: qty,
        requirements: [],
      };
    }

    const requirements: MaterialRequirementDetail[] = (foundRecipe.product_recipe_items || []).map((item) => {
      const plannedPerKg = Number(item.planned_kg_per_kg_output) || (Number(item.percentage || 0) / 100) || 1;
      const requiredKg = Number((qty * plannedPerKg).toFixed(4));
      const mat = inMemMaterials.find((m) => m.id === item.material_id);
      const availableBatches = inMemBatches.filter(
        (b) => b.tenant_id === tenantId && b.material_id === item.material_id && b.status === 'available' && Number(b.remaining_quantity_kg || 0) > 0
      );
      const totalAvailable = Number(availableBatches.reduce((acc, b) => acc + Number(b.remaining_quantity_kg || 0), 0).toFixed(4));

      return {
        material_id: item.material_id,
        material_code: item.materials?.code || mat?.code || 'MAT-RAW',
        material_name: item.materials?.name || mat?.name || 'Raw Material',
        plate_type: item.plate_type || 'A',
        plate_a_kg: Number(item.plate_a_kg || 0),
        plate_b_kg: Number(item.plate_b_kg || 0),
        plate_c_kg: Number(item.plate_c_kg || 0),
        quantity_kg: Number(item.quantity_kg || item.percentage || Number((plannedPerKg * 100).toFixed(2))),
        percentage: Number(item.percentage || 0),
        planned_kg_per_kg_output: plannedPerKg,
        required_kg: requiredKg,
        available_stock_kg: totalAvailable,
        sufficient: totalAvailable >= requiredKg,
        suggested_batches: availableBatches,
      };
    });

    const allSufficient = requirements.every((r) => r.sufficient);
    const missing = requirements
      .filter((r) => !r.sufficient)
      .map((r) => `"${r.material_name}" requires ${r.required_kg} kg but only ${r.available_stock_kg} kg is available in stock`);

    return {
      sufficient: allSufficient,
      all_sufficient: allSufficient,
      recipe_id: foundRecipe.id,
      product_id: resolvedProductId,
      planned_quantity_kg: qty,
      requirements,
      plate_summary: computePlateSummary(
        foundRecipe.product_recipe_items || foundRecipe.plate_a_kg,
        foundRecipe.plate_b_kg,
        foundRecipe.plate_c_kg,
        foundRecipe.total_batch_kg,
        qty
      ),
      missingDetails: missing.length > 0 ? missing.join('; ') : undefined,
    };
  }

  // Supabase implementation
  let recipe: any = null;
  let resolvedProductId = productId;

  if (recipeId) {
    const { data: recData } = await supabase
      .from('product_recipes')
      .select(`
        id, version, product_id, is_active, plate_a_kg, plate_b_kg, plate_c_kg, total_batch_kg,
        product_recipe_items (
          material_id, plate_type, plate_a_kg, plate_b_kg, plate_c_kg, quantity_kg, percentage, planned_kg_per_kg_output,
          materials (id, code, name, standard_unit)
        )
      `)
      .eq('id', recipeId)
      .eq('tenant_id', tenantId)
      .single();
    recipe = recData;
    if (recipe) resolvedProductId = recipe.product_id;
  } else if (productId) {
    const { data: recData } = await supabase
      .from('product_recipes')
      .select(`
        id, version, product_id, is_active, plate_a_kg, plate_b_kg, plate_c_kg, total_batch_kg,
        product_recipe_items (
          material_id, plate_type, plate_a_kg, plate_b_kg, plate_c_kg, quantity_kg, percentage, planned_kg_per_kg_output,
          materials (id, code, name, standard_unit)
        )
      `)
      .eq('product_id', productId)
      .eq('tenant_id', tenantId)
      .order('is_active', { ascending: false })
      .order('version', { ascending: false });

    recipe = (recData && recData.length > 0) ? (recData.find((r: any) => r.is_active) || recData[0]) : null;
  }

  if (!recipe || !recipe.product_recipe_items || recipe.product_recipe_items.length === 0) {
    return {
      sufficient: true,
      all_sufficient: true,
      planned_quantity_kg: qty,
      requirements: [],
    };
  }

  const requirements: MaterialRequirementDetail[] = await Promise.all(
    (recipe.product_recipe_items || []).map(async (item: any) => {
      const plannedPerKg = Number(item.planned_kg_per_kg_output) || (Number(item.percentage || 0) / 100) || 1;
      const requiredKg = Number((qty * plannedPerKg).toFixed(4));
      const { data: batches } = await supabase
        .from('material_batches')
        .select('id, batch_number, remaining_quantity_kg, receipt_date')
        .eq('material_id', item.material_id)
        .eq('tenant_id', tenantId)
        .eq('status', 'available')
        .gt('remaining_quantity_kg', 0)
        .order('receipt_date', { ascending: true });

      const totalAvailable = Number(
        (batches || []).reduce((acc: number, b: any) => acc + Number(b.remaining_quantity_kg || 0), 0).toFixed(4)
      );

      return {
        material_id: item.material_id,
        material_code: item.materials?.code || 'MAT-RAW',
        material_name: item.materials?.name || 'Raw Material',
        plate_type: item.plate_type || 'A',
        plate_a_kg: Number(item.plate_a_kg || 0),
        plate_b_kg: Number(item.plate_b_kg || 0),
        plate_c_kg: Number(item.plate_c_kg || 0),
        quantity_kg: Number(item.quantity_kg || item.percentage || Number((plannedPerKg * 100).toFixed(2))),
        percentage: Number(item.percentage || 0),
        planned_kg_per_kg_output: plannedPerKg,
        required_kg: requiredKg,
        available_stock_kg: totalAvailable,
        sufficient: totalAvailable >= requiredKg,
        suggested_batches: batches || [],
      };
    })
  );

  const allSufficient = requirements.every((r) => r.sufficient);
  const missing = requirements
    .filter((r) => !r.sufficient)
    .map((r) => `"${r.material_name}" requires ${r.required_kg} kg but only ${r.available_stock_kg} kg is available in stock`);

  return {
    sufficient: allSufficient,
    all_sufficient: allSufficient,
    recipe_id: recipe.id,
    product_id: resolvedProductId,
    planned_quantity_kg: qty,
    requirements,
    plate_summary: computePlateSummary(
      recipe.product_recipe_items || recipe.plate_a_kg,
      recipe.plate_b_kg,
      recipe.plate_c_kg,
      recipe.total_batch_kg,
      qty
    ),
    missingDetails: missing.length > 0 ? missing.join('; ') : undefined,
  };
}

// Calculate planned raw material requirements before production (PRD-05)
export const calculateRequirements = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { recipeId, productId, quantityKg } = req.body;

    if ((!recipeId && !productId) || !quantityKg || Number(quantityKg) <= 0) {
      return res.status(400).json({ success: false, message: 'recipeId or productId and positive quantityKg required' });
    }

    const check = await checkProductMaterialStock(tenantId, productId, recipeId, Number(quantityKg));

    return res.json({
      success: true,
      recipe_id: check.recipe_id,
      product_id: check.product_id,
      planned_quantity_kg: check.planned_quantity_kg,
      all_sufficient: check.all_sufficient,
      sufficient: check.sufficient,
      requirements: check.requirements,
      missingDetails: check.missingDetails,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 1-Click Seed Standard Products & Packaging Recipes (PRD-01)
export const seedDefaultProducts = async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const userId = req.user?.id;

    // Get available materials in this tenant to link recipes
    let availableMaterials: any[] = [];
    if (!isSupabaseConfigured) {
      availableMaterials = inMemMaterials.filter((m) => m.tenant_id === tenantId);
    } else {
      const { data: mats } = await supabase
        .from('materials')
        .select('id, code, name')
        .eq('tenant_id', tenantId);
      availableMaterials = mats || [];
    }

    const defaultDefs = [
      {
        code: `PRD-${Math.floor(Math.random() * 9000 + 1000)}`,
        name: '3-Layer Milk Pouch Packaging Film (50 Micron)',
        description: 'Co-extruded high-barrier film for liquid dairy packaging with excellent puncture resistance.',
        unit: 'kg',
        standardWeightKg: 1.0,
        ratios: [
          { percent: 60, perKg: 0.60 },
          { percent: 30, perKg: 0.30 },
          { percent: 10, perKg: 0.10 },
        ],
      },
      {
        code: `PRD-${Math.floor(Math.random() * 9000 + 1000)}`,
        name: 'Heavy-Duty Industrial Polymer Liners (100 Micron)',
        description: 'Gusseted liners for chemical, fertilizer, and agricultural batch packaging bags.',
        unit: 'kg',
        standardWeightKg: 1.0,
        ratios: [
          { percent: 80, perKg: 0.80 },
          { percent: 20, perKg: 0.20 },
        ],
      },
      {
        code: `PRD-${Math.floor(Math.random() * 9000 + 1000)}`,
        name: 'Tamper-Evident Courier & Mailing Security Bags',
        description: 'Multi-layer security mailer bags with hot-melt permanent adhesive closure.',
        unit: 'kg',
        standardWeightKg: 1.0,
        ratios: [
          { percent: 70, perKg: 0.70 },
          { percent: 25, perKg: 0.25 },
          { percent: 5, perKg: 0.05 },
        ],
      },
    ];

    if (!isSupabaseConfigured) {
      const created: InMemProduct[] = [];
      for (const def of defaultDefs) {
        const prodId = crypto.randomUUID();
        const recId = crypto.randomUUID();

        // Build recipe items linking available materials
        const items: InMemRecipeItem[] = def.ratios.map((ratio, idx) => {
          const mat = availableMaterials[idx % Math.max(availableMaterials.length, 1)];
          const plate = (['A', 'B', 'C'][idx % 3] || 'A') as 'A' | 'B' | 'C';
          return {
            id: crypto.randomUUID(),
            recipe_id: recId,
            material_id: mat?.id || `mat-${idx + 1}`,
            plate_type: plate,
            quantity_kg: ratio.percent,
            percentage: ratio.percent,
            planned_kg_per_kg_output: ratio.perKg,
            materials: mat ? { id: mat.id, code: mat.code, name: mat.name, standard_unit: 'kg' } : undefined,
          };
        });

        const newRec: InMemRecipe = {
          id: recId,
          tenant_id: tenantId,
          product_id: prodId,
          version: 1,
          is_active: true,
          notes: 'Standard certified extrusion recipe (V1)',
          created_by: userId,
          effective_date: new Date().toISOString(),
          product_recipe_items: items,
        };

        const prod: InMemProduct = {
          id: prodId,
          tenant_id: tenantId,
          code: def.code,
          name: def.name,
          description: def.description,
          unit: def.unit,
          standard_weight_kg: def.standardWeightKg,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          product_recipes: [newRec],
        };

        inMemProducts.push(prod);
        created.push(prod);
      }

      return res.status(201).json({
        success: true,
        message: 'Configured 3 standard packaging products with recipes!',
        products: created,
      });
    }

    // Supabase mode:
    const seeded = [];
    for (const def of defaultDefs) {
      const { data: prod, error: prdErr } = await supabase
        .from('products')
        .insert({
          tenant_id: tenantId,
          code: def.code,
          name: def.name,
          description: def.description,
          unit: def.unit,
          standard_weight_kg: def.standardWeightKg,
        })
        .select('*')
        .single();

      if (prdErr) continue;

      // Create recipe v1
      const { data: rec, error: recErr } = await supabase
        .from('product_recipes')
        .insert({
          tenant_id: tenantId,
          product_id: prod.id,
          version: 1,
          is_active: true,
          notes: 'Standard certified extrusion recipe (V1)',
          created_by: userId,
        })
        .select('*')
        .single();

      if (!recErr && availableMaterials.length > 0) {
        const items = def.ratios.map((ratio, idx) => {
          const mat = availableMaterials[idx % availableMaterials.length];
          const plate = ['A', 'B', 'C'][idx % 3] || 'A';
          return {
            recipe_id: rec.id,
            material_id: mat.id,
            plate_type: plate,
            quantity_kg: ratio.percent,
            percentage: ratio.percent,
            planned_kg_per_kg_output: ratio.perKg,
          };
        });
        await supabase.from('product_recipe_items').insert(items);
      }

      seeded.push(prod);
    }

    return res.status(201).json({
      success: true,
      message: `Configured ${seeded.length} standard packaging products with versioned recipes!`,
      products: seeded,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
