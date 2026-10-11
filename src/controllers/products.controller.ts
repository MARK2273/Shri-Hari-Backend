import { Request, Response } from 'express';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { z } from 'zod';

export const getProducts = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;

    if (!isSupabaseConfigured) {
      return res.json({ success: true, products: [] });
    }

    const { data: products, error } = await supabase
      .from('products')
      .select(`
        *,
        product_recipes (
          id, version, is_active, notes, effective_date,
          product_recipe_items (
            id, material_id, percentage, planned_kg_per_kg_output,
            materials (id, code, name, standard_unit)
          )
        )
      `)
      .eq('tenant_id', tenantId)
      .order('code', { ascending: true });

    if (error) throw error;

    // Map to include latest active recipe
    const enriched = products.map((p: any) => {
      const activeRecipe = (p.product_recipes || []).find((r: any) => r.is_active) || p.product_recipes?.[0];
      return {
        ...p,
        active_recipe: activeRecipe
      };
    });

    return res.json({ success: true, products: enriched });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createProduct = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    const userId = req.user?.id;

    const schema = z.object({
      code: z.string().min(2),
      name: z.string().min(2),
      description: z.string().optional(),
      unit: z.enum(['kg', 'pcs', 'rolls']).default('kg'),
      standardWeightKg: z.number().positive().default(1.0),
      initialRecipe: z.object({
        notes: z.string().optional(),
        items: z.array(z.object({
          materialId: z.string().uuid(),
          percentage: z.number().min(0).max(100),
          plannedKgPerKgOutput: z.number().positive()
        })).min(1)
      }).optional()
    });

    const body = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      return res.status(201).json({
        success: true,
        product: { id: `prd-${Date.now()}`, ...body, is_active: true }
      });
    }

    // 1. Create product
    const { data: product, error: prdError } = await supabase
      .from('products')
      .insert({
        tenant_id: tenantId,
        code: body.code.toUpperCase(),
        name: body.name,
        description: body.description,
        unit: body.unit,
        standard_weight_kg: body.standardWeightKg
      })
      .select('*')
      .single();

    if (prdError) throw prdError;

    // 2. Create version 1 recipe if supplied
    if (body.initialRecipe) {
      const { data: recipe, error: recError } = await supabase
        .from('product_recipes')
        .insert({
          tenant_id: tenantId,
          product_id: product.id,
          version: 1,
          is_active: true,
          notes: body.initialRecipe.notes,
          created_by: userId
        })
        .select('*')
        .single();

      if (recError) throw recError;

      const items = body.initialRecipe.items.map(item => ({
        recipe_id: recipe.id,
        material_id: item.materialId,
        percentage: item.percentage,
        planned_kg_per_kg_output: item.plannedKgPerKgOutput
      }));

      await supabase.from('product_recipe_items').insert(items);
    }

    return res.status(201).json({ success: true, product });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, errors: error.issues });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Create a new version of a recipe (PRD-04: Versioning preserved)
export const addRecipeVersion = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    const userId = req.user?.id;
    const { productId } = req.params;

    const schema = z.object({
      notes: z.string().optional(),
      items: z.array(z.object({
        materialId: z.string().uuid(),
        percentage: z.number().min(0).max(100),
        plannedKgPerKgOutput: z.number().positive()
      })).min(1)
    });

    const body = schema.parse(req.body);

    if (!isSupabaseConfigured) {
      return res.status(201).json({ success: true, message: 'Recipe version added (mock mode)' });
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
        created_by: userId
      })
      .select('*')
      .single();

    if (recError) throw recError;

    const items = body.items.map(i => ({
      recipe_id: newRecipe.id,
      material_id: i.materialId,
      percentage: i.percentage,
      planned_kg_per_kg_output: i.plannedKgPerKgOutput
    }));

    await supabase.from('product_recipe_items').insert(items);

    return res.status(201).json({ success: true, recipe: newRecipe, version: nextVersion });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Calculate planned raw material requirements before production (PRD-05)
export const calculateRequirements = async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    const { recipeId, quantityKg } = req.body;

    if (!recipeId || !quantityKg || quantityKg <= 0) {
      return res.status(400).json({ success: false, message: 'recipeId and positive quantityKg required' });
    }

    if (!isSupabaseConfigured) {
      return res.json({
        success: true,
        total_quantity_kg: quantityKg,
        requirements: [
          { material_id: 'mat-1', material_name: 'Plastic Type A', percentage: 50, required_kg: quantityKg * 0.5, available_stock_kg: 2500, sufficient: true },
          { material_id: 'mat-2', material_name: 'Plastic Type B', percentage: 30, required_kg: quantityKg * 0.3, available_stock_kg: 2000, sufficient: true },
          { material_id: 'mat-4', material_name: 'Plastic Type D', percentage: 20, required_kg: quantityKg * 0.2, available_stock_kg: 1200, sufficient: true }
        ]
      });
    }

    const { data: recipe, error: recError } = await supabase
      .from('product_recipes')
      .select(`
        id, version, product_id,
        product_recipe_items (
          material_id, percentage, planned_kg_per_kg_output,
          materials (id, code, name, standard_unit)
        )
      `)
      .eq('id', recipeId)
      .eq('tenant_id', tenantId)
      .single();

    if (recError || !recipe) {
      return res.status(404).json({ success: false, message: 'Recipe not found' });
    }

    // Check available batches for each material
    const requirements = await Promise.all(
      (recipe.product_recipe_items || []).map(async (item: any) => {
        const requiredKg = Number(quantityKg) * Number(item.planned_kg_per_kg_output);
        const { data: batches } = await supabase
          .from('material_batches')
          .select('id, batch_number, remaining_quantity_kg, receipt_date')
          .eq('material_id', item.material_id)
          .eq('tenant_id', tenantId)
          .eq('status', 'available')
          .gt('remaining_quantity_kg', 0)
          .order('receipt_date', { ascending: true }); // FIFO order

        const totalAvailable = (batches || []).reduce((acc: number, b: any) => acc + Number(b.remaining_quantity_kg), 0);

        return {
          material_id: item.material_id,
          material_code: item.materials?.code,
          material_name: item.materials?.name,
          percentage: item.percentage,
          planned_kg_per_kg_output: item.planned_kg_per_kg_output,
          required_kg: requiredKg,
          available_stock_kg: totalAvailable,
          sufficient: totalAvailable >= requiredKg,
          suggested_batches: batches // FIFO suggested lots
        };
      })
    );

    const allSufficient = requirements.every(r => r.sufficient);

    return res.json({
      success: true,
      recipe_id: recipe.id,
      planned_quantity_kg: quantityKg,
      all_sufficient: allSufficient,
      requirements
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
