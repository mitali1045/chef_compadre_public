// URL learning API - extracts recipe info from YouTube/blog URLs
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { analyzeNutrition } = require('./conversation_consolidated');
const { createClient } = require('@supabase/supabase-js');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Initialize Supabase client for saving recipes
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey);
}

// Helper function to check if user_id is a valid UUID
function isValidUUID(userId) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(userId);
}

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { url, content } = req.body;

    if (!url && !content) {
      return res.status(400).json({ error: 'URL or content required' });
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });

    const prompt = `Analyze this cooking content and extract a structured recipe that I can guide users through step-by-step.

${url ? `URL: ${url}` : ''}
${content ? `Content: ${content}` : ''}

Extract and format as JSON:
{
  "title": "Recipe title",
  "description": "Brief description",
  "servings": number,
  "prep_time": "X minutes",
  "cook_time": "X minutes",
  "total_time": "X minutes",
  "difficulty": "Easy/Medium/Hard",
  "ingredients": [
    {
      "name": "ingredient name",
      "amount": "1 cup",
      "notes": "optional notes"
    }
  ],
  "steps": [
    {
      "step": 1,
      "instruction": "detailed step",
      "tips": "optional cooking tips",
      "timing": "optional timing"
    }
  ],
  "equipment": ["equipment1", "equipment2"],
  "tips": ["tip1", "tip2"],
  "substitutions": {
    "original": "substitution"
  },
  "dietary_tags": ["vegan", "gluten-free"],
  "cuisine": "type of cuisine",
  "source_url": "${url || ''}"
}

Make it practical for step-by-step cooking guidance. Include timing, temperature, and technique details.`;

    const result = await model.generateContent(prompt);
    const resp = await result.response;
    const recipeData = resp.text();

    // Try to parse JSON response
    let recipe;
    try {
      recipe = JSON.parse(recipeData);
    } catch (parseError) {
      // If not JSON, create a structured response
      recipe = {
        title: "Extracted Recipe",
        description: "Recipe extracted from content",
        servings: 4,
        prep_time: "15 minutes",
        cook_time: "30 minutes",
        total_time: "45 minutes",
        difficulty: "Medium",
        ingredients: [],
        steps: [],
        equipment: [],
        tips: [],
        substitutions: {},
        dietary_tags: [],
        cuisine: "Unknown",
        source_url: url || '',
        raw_analysis: recipeData
      };
    }

    // Analyze nutrition for the extracted recipe using shared module
    let nutritionData = null;
    try {
      console.log('Analyzing nutrition for URL-learned recipe...');
      
      // Create a recipe text for nutrition analysis
      const recipeText = `${recipe.title}\n\nIngredients:\n${recipe.ingredients.map(ing => `- ${ing.amount} ${ing.name}${ing.notes ? ` (${ing.notes})` : ''}`).join('\n')}\n\nInstructions:\n${recipe.steps.map(step => `${step.step}. ${step.instruction}`).join('\n')}`;
      
      // Use shared nutrition analysis module
      nutritionData = await analyzeNutrition(recipeText, recipe.servings || 1);
    } catch (nutritionError) {
      console.error('Nutrition analysis failed for URL recipe:', nutritionError);
      // Continue without nutrition data
    }

    // Save recipe to database for future guidance
    let savedRecipeId = null;
    if (supabase && isValidUUID(req.body.user_id)) {
      try {
        const { data: savedRecipe, error: saveError } = await supabase
          .from('saved_recipes')
          .insert({
            user_id: req.body.user_id,
            title: recipe.title,
            recipe_data: recipe,
            source_url: url || '',
            source_type: 'url',
            tags: recipe.dietary_tags || [],
            difficulty: recipe.difficulty || 'medium',
            prep_time: recipe.prep_time ? parseInt(recipe.prep_time) : null,
            cook_time: recipe.cook_time ? parseInt(recipe.cook_time) : null,
            servings: recipe.servings || 4
          })
          .select('id')
          .single();
        
        if (saveError) {
          console.error('Error saving URL recipe:', saveError);
        } else {
          savedRecipeId = savedRecipe.id;
          console.log('Recipe saved with ID:', savedRecipeId);
        }
      } catch (saveError) {
        console.error('Error saving recipe to database:', saveError);
      }
    } else if (!isValidUUID(req.body.user_id)) {
      console.log('Skipping recipe save for non-UUID user:', req.body.user_id);
    }

    // Create a comprehensive response
    const response = { 
      recipe,
      success: true,
      message: `Successfully extracted recipe: ${recipe.title}`,
      saved: !!savedRecipeId,
      recipe_id: savedRecipeId,
      note: !isValidUUID(req.body.user_id) ? 'Recipe not saved (demo user)' : undefined
    };
    
    if (nutritionData) {
      response.nutrition = nutritionData;
    }

    return res.json(response);
  } catch (error) {
    console.error('URL learning error:', error);
    return res.status(500).json({ 
      error: 'Failed to analyze content',
      message: error.message 
    });
  }
};
