// api/conversation_consolidated.js
// Consolidated conversation service with all functionality
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey);
}

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// In-memory conversation history (fallback when Supabase fails)
const conversationHistory = new Map();

// ==============================================
// SAFETY GUARDRAILS (merged from safety_guardrails.js)
// ==============================================
const HARMFUL_PATTERNS = [
  /weapon|gun|knife.*attack|violence|harm.*person|hurt.*someone/i,
  /poison|toxic|dangerous.*substance|harmful.*chemical/i,
  /suicide|self.*harm|end.*life|kill.*myself/i,
  /dangerous.*activity|risky.*behavior/i,
  /illegal.*drug|substance.*abuse|drug.*recipe/i,
  /steal|theft|robbery|illegal.*activity/i,
  /explicit|adult.*content|inappropriate/i,
  /hate.*speech|discrimination|offensive/i,
  /unsafe.*cooking|dangerous.*kitchen|harmful.*food/i,
  /contaminated.*food|food.*poisoning|unsafe.*ingredient/i
];

const COOKING_SAFETY_PATTERNS = [
  /raw.*meat.*without.*cooking/i,
  /undercooked.*chicken|raw.*eggs.*unsafe/i,
  /cross.*contamination|unsafe.*storage/i,
  /expired.*food|moldy.*ingredient/i,
  /allergen.*without.*warning/i
];

function getSafeSystemPrompt() {
  return `You are Chef Compadre, a friendly AI cooking assistant focused on safe, healthy cooking practices.

SAFETY GUIDELINES:
- Only provide cooking advice and food-related information
- Never provide information about harmful substances, weapons, or dangerous activities
- Always emphasize food safety and proper cooking techniques
- If asked about non-cooking topics, politely redirect to cooking
- Never provide medical advice - suggest consulting healthcare professionals
- Always warn about food allergies and cross-contamination risks

COOKING FOCUS:
- Be concise, step-by-step, and proactive
- If the user lacks an ingredient, suggest 1–3 realistic substitutions
- Explain trade-offs and safety considerations
- Keep it kitchen-practical and safe
- Assume the user is already cooking; keep responses short and doable

If asked about anything outside of cooking, food, or kitchen safety, politely decline and redirect to cooking topics.`;
}

function validateInput(input) {
  if (!input || typeof input !== 'string') {
    return { safe: false, reason: 'Invalid input', category: 'invalid' };
  }

  const lowerInput = input.toLowerCase();

  // Check for harmful patterns
  for (const pattern of HARMFUL_PATTERNS) {
    if (pattern.test(input)) {
      return { safe: false, reason: 'Contains harmful content', category: 'harmful' };
    }
  }

  // Check for cooking safety issues
  for (const pattern of COOKING_SAFETY_PATTERNS) {
    if (pattern.test(input)) {
      return { safe: false, reason: 'Unsafe cooking practice', category: 'unsafe_cooking' };
    }
  }

  return { safe: true };
}

function filterResponse(response) {
  if (!response || typeof response !== 'string') {
    return 'I can only help with cooking and food-related topics.';
  }

  // Basic response filtering
  const lowerResponse = response.toLowerCase();
  
  if (lowerResponse.includes('harmful') || lowerResponse.includes('dangerous')) {
    return 'I can only provide safe cooking advice. Please ask me about recipes, ingredients, or cooking techniques!';
  }

  return response;
}

function logSafetyViolation(userId, input, reason, category) {
  console.warn(`Safety violation detected:`, {
    userId,
    input: input.substring(0, 100) + '...',
    reason,
    category,
    timestamp: new Date().toISOString()
  });
}

// ==============================================
// USER DATA FUNCTIONS (merged from user_data.js)
// ==============================================
function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

async function getUserPreferences(userId) {
  if (!supabase) {
    console.warn('User data service: Supabase not configured');
    return [];
  }
  
  // Skip database query for non-UUID user IDs (like 'demo-user')
  if (!isValidUUID(userId)) {
    console.log('Skipping database query for non-UUID user:', userId);
    return [];
  }
  
  try {
    const { data, error } = await supabase
      .from('user_preferences')
      .select('preference_type, preference_value, confidence_score, last_used')
      .eq('user_id', userId)
      .order('confidence_score', { ascending: false })
      .order('last_used', { ascending: false });
    
    if (error) {
      console.error('User data service: Error fetching preferences:', error);
      return [];
    }
    
    return data || [];
  } catch (error) {
    console.error('User data service: Error in getUserPreferences:', error);
    return [];
  }
}

async function getUserMemory(userId, memoryType = null) {
  if (!supabase) {
    console.warn('User data service: Supabase not configured');
    return [];
  }
  
  // Skip database query for non-UUID user IDs (like 'demo-user')
  if (!isValidUUID(userId)) {
    console.log('Skipping database query for non-UUID user:', userId);
    return [];
  }
  
  try {
    let query = supabase
      .from('conversation_memory')
      .select('memory_type, memory_content, context, confidence_score, created_at')
      .eq('user_id', userId)
      .gt('expires_at', new Date().toISOString())
      .order('confidence_score', { ascending: false })
      .order('created_at', { ascending: false });
    
    if (memoryType) {
      query = query.eq('memory_type', memoryType);
    }
    
    const { data, error } = await query;
    
    if (error) {
      console.error('User data service: Error fetching memory:', error);
      return [];
    }
    
    return data || [];
  } catch (error) {
    console.error('User data service: Error in getUserMemory:', error);
    return [];
  }
}

async function getUserRecipes(userId, includeFullData = false) {
  if (!supabase) {
    console.warn('User data service: Supabase not configured');
    return [];
  }
  
  // Skip database query for non-UUID user IDs (like 'demo-user')
  if (!isValidUUID(userId)) {
    console.log('Skipping database query for non-UUID user:', userId);
    return [];
  }
  
  try {
    // Select fields based on whether full data is needed
    const selectFields = includeFullData 
      ? 'id, title, difficulty, prep_time, cook_time, servings, rating, created_at, recipe_data, source_url, tags'
      : 'id, title, difficulty, prep_time, cook_time, servings, rating, created_at';
    
    const { data, error } = await supabase
      .from('saved_recipes')
      .select(selectFields)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10);
    
    if (error) {
      console.error('User data service: Error fetching recipes:', error);
      return [];
    }
    
    return data || [];
  } catch (error) {
    console.error('User data service: Error in getUserRecipes:', error);
    return [];
  }
}

async function getRecipeById(userId, recipeId) {
  if (!supabase) {
    console.warn('User data service: Supabase not configured');
    return null;
  }
  
  // Skip database query for non-UUID user IDs (like 'demo-user')
  if (!isValidUUID(userId)) {
    console.log('Skipping database query for non-UUID user:', userId);
    return null;
  }
  
  try {
    const { data, error } = await supabase
      .from('saved_recipes')
      .select('*')
      .eq('user_id', userId)
      .eq('id', recipeId)
      .single();
    
    if (error) {
      console.error('User data service: Error fetching recipe:', error);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('User data service: Error in getRecipeById:', error);
    return null;
  }
}

async function getRecipeByTitle(userId, title) {
  if (!supabase) {
    console.warn('User data service: Supabase not configured');
    return null;
  }
  
  // Skip database query for non-UUID user IDs (like 'demo-user')
  if (!isValidUUID(userId)) {
    console.log('Skipping database query for non-UUID user:', userId);
    return null;
  }
  
  try {
    const { data, error } = await supabase
      .from('saved_recipes')
      .select('*')
      .eq('user_id', userId)
      .ilike('title', `%${title}%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (error) {
      console.error('User data service: Error fetching recipe by title:', error);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('User data service: Error in getRecipeByTitle:', error);
    return null;
  }
}

async function saveUserPreference(userId, preferenceType, preferenceValue, confidence = 3) {
  if (!supabase) {
    console.warn('User data service: Supabase not configured');
    return false;
  }
  
  try {
    const { error } = await supabase
      .from('user_preferences')
      .upsert({
        user_id: userId,
        preference_type: preferenceType,
        preference_value: preferenceValue,
        confidence_score: confidence,
        last_used: new Date().toISOString()
      });
    
    if (error) {
      console.error('User data service: Error saving preference:', error);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('User data service: Error in saveUserPreference:', error);
    return false;
  }
}

async function addToShoppingList(userId, items) {
  if (!supabase) {
    console.warn('User data service: Supabase not configured');
    return false;
  }
  
  try {
    const shoppingItems = items.map(item => ({
      user_id: userId,
      item: item.name,
      quantity: item.quantity || '',
      category: item.category || 'general',
      priority: 2
    }));
    
    const { error } = await supabase
      .from('shopping_lists')
      .insert(shoppingItems);
    
    if (error) {
      console.error('User data service: Error adding to shopping list:', error);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('User data service: Error in addToShoppingList:', error);
    return false;
  }
}

async function saveRecipe(userId, recipeData) {
  if (!supabase) {
    console.warn('User data service: Supabase not configured');
    return false;
  }
  
  try {
    const { error } = await supabase
      .from('saved_recipes')
      .insert({
        user_id: userId,
        title: recipeData.title,
        recipe_data: recipeData,
        tags: recipeData.tags || [],
        difficulty: recipeData.difficulty || 'medium',
        prep_time: recipeData.prep_time ? parseInt(recipeData.prep_time) : null,
        cook_time: recipeData.cook_time ? parseInt(recipeData.cook_time) : null,
        servings: recipeData.servings || 4,
        source_type: 'chat'
      });
    
    if (error) {
      console.error('User data service: Error saving recipe:', error);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('User data service: Error in saveRecipe:', error);
    return false;
  }
}

// ==============================================
// NUTRITION ANALYSIS (merged from nutrition_analyzer.js)
// ==============================================
async function analyzeNutrition(recipeText, servings = 1) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });

    const prompt = `Analyze the nutritional content of this recipe and provide ONLY a JSON response.

Recipe: ${recipeText}

Return ONLY this JSON format (no other text):
{
  "calories": 300,
  "protein": 15,
  "carbs": 25,
  "fat": 10,
  "fiber": 5,
  "sugar": 8,
  "sodium": 400,
  "vitamins": ["vitamin C", "vitamin A"],
  "minerals": ["iron", "calcium"],
  "health_benefits": ["high protein", "low carb"],
  "dietary_tags": ["vegetarian", "gluten-free"],
  "servings": ${servings}
}

IMPORTANT: Return ONLY the JSON object, no explanations or additional text.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const nutritionData = response.text();

    // Try to parse JSON response
    let nutrition;
    try {
      // Clean the response - remove any markdown formatting
      const cleanedData = nutritionData.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      nutrition = JSON.parse(cleanedData);
    } catch (parseError) {
      console.error('Failed to parse nutrition JSON from Gemini:', parseError);
      console.error('Raw response:', nutritionData);
      
      // If not JSON, create a structured response with fallback values
      nutrition = {
        calories: 300,
        protein: 15,
        carbs: 25,
        fat: 10,
        fiber: 5,
        sugar: 8,
        sodium: 400,
        vitamins: ["vitamin C", "vitamin A"],
        minerals: ["iron", "calcium"],
        health_benefits: ["nutritious", "balanced"],
        dietary_tags: ["healthy"],
        servings: servings,
        raw_analysis: nutritionData
      };
    }
    return nutrition;
  } catch (error) {
    console.error('Nutrition analysis error:', error);
    throw error;
  }
}

// ==============================================
// AGENTIC CONVERSATION WITH FUNCTION CALLING
// ==============================================
const tools = [
  {
    function_declarations: [
      {
        name: "add_to_shopping_list",
        description: "Add ingredients to user's shopping list when they mention needing items",
        parameters: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Ingredient name" },
                  quantity: { type: "string", description: "Amount needed" },
                  category: { type: "string", description: "Food category like 'produce', 'dairy', 'pantry'" }
                },
                required: ["name"]
              }
            }
          },
          required: ["items"]
        }
      },
      {
        name: "save_recipe",
        description: "Save a recipe to user's collection when they show interest in a recipe",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Recipe title" },
            ingredients: { 
              type: "array", 
              description: "List of ingredients",
              items: { type: "string" }
            },
            steps: { 
              type: "array", 
              description: "Cooking steps",
              items: { type: "string" }
            },
            tags: { 
              type: "array", 
              description: "Recipe tags like 'vegan', 'quick', 'italian'",
              items: { type: "string" }
            },
            prep_time: { type: "string", description: "Preparation time" },
            cook_time: { type: "string", description: "Cooking time" },
            servings: { type: "number", description: "Number of servings" }
          },
          required: ["title", "ingredients", "steps"]
        }
      },
      {
        name: "update_preferences",
        description: "Update user's dietary preferences when they mention dietary choices",
        parameters: {
          type: "object",
          properties: {
            preference_type: { type: "string", enum: ["diet", "allergy", "cooking_skill", "cuisine"] },
            preference_value: { type: "string", description: "The preference value" },
            confidence: { type: "number", description: "Confidence level 1-5" }
          },
          required: ["preference_type", "preference_value"]
        }
      },
      {
        name: "suggest_substitutions",
        description: "Suggest ingredient substitutions based on user preferences",
        parameters: {
          type: "object",
          properties: {
            original_ingredient: { type: "string", description: "Ingredient to substitute" },
            reason: { type: "string", description: "Why substitution is needed" },
            alternatives: { 
              type: "array", 
              description: "Suggested alternatives",
              items: { type: "string" }
            }
          },
          required: ["original_ingredient", "alternatives"]
        }
      },
      {
        name: "guide_recipe_step",
        description: "Guide user through a specific step of a recipe they're cooking",
        parameters: {
          type: "object",
          properties: {
            step_number: { type: "number", description: "Current step number" },
            step_description: { type: "string", description: "Detailed step instructions" },
            tips: { 
              type: "array", 
              description: "Helpful tips for this step",
              items: { type: "string" }
            },
            timing: { type: "string", description: "How long this step takes" },
            next_step: { type: "string", description: "What comes next" }
          },
          required: ["step_number", "step_description"]
        }
      },
      {
        name: "show_reference_images",
        description: "MANDATORY: Call this function whenever the user asks to SEE, VIEW, or SHOW anything visually. This includes phrases like 'show me', 'what does it look like', 'how does it look', 'can you show me', 'picture of', 'image of', 'see how it looks'. Extract the subject from conversation context if user uses pronouns like 'it', 'that', 'this'. ALWAYS call this tool - never just describe visually.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query for images. Extract from user's message or recent conversation context. If user says 'how does it look' or 'show me that', identify what 'it' or 'that' refers to from the conversation (e.g., 'fried rice', 'grilled salmon', 'diced onions'). Examples: 'fried rice', 'grilled salmon', 'diced onions', 'sautéing technique'" },
            reason: { type: "string", description: "Why showing images (e.g., 'User wants to see what the dish looks like', 'User asked how it looks')" }
          },
          required: ["query"]
        }
      }
    ]
  }
];

// Light jailbreak protection
function checkCookingIntent(message) {
  const lowerMessage = message.toLowerCase();
  
  // Check for obvious non-food metaphors
  const metaphorPhrases = ['in terms of', 'represents', 'symbolizes', 'as if', 'like a'];
  const nonFoodTopics = [
    'politics', 'political', 'economy', 'economic', 'recession', 'depression',
    'government', 'war', 'conflict', 'religion', 'religious',
    'election', 'president', 'congress', 'senate'
  ];
  
  const hasMetaphor = metaphorPhrases.some(phrase => lowerMessage.includes(phrase));
  const hasNonFoodTopic = nonFoodTopics.some(topic => lowerMessage.includes(topic));
  
  // If using cooking as metaphor for serious topics, politely decline
  if (hasMetaphor && hasNonFoodTopic) {
    console.log('⚠️ Potential metaphorical cooking request detected');
    return {
      safe: false,
      message: "I appreciate the creative metaphor! However, I'm specifically designed to help with actual cooking and recipes. I'd love to help you make a real biryani, pasta, or any other dish though! What would you like to cook today? 🍳"
    };
  }
  
  return { safe: true };
}

async function processWithAgent(userId, message, conversationHistory) {
  try {
    // Check cooking intent (light jailbreak protection)
    const intentCheck = checkCookingIntent(message);
    if (!intentCheck.safe) {
      console.log('🛡️ Guardrail triggered - redirecting to cooking');
      return {
        response: intentCheck.message,
        actions: []
      };
    }
    
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.5-pro',  // Using available model (supports function calling)
      tools: tools,
      // Ensure the model is allowed to auto-call tools
      toolConfig: {
        functionCallingConfig: { mode: 'AUTO' }
      },
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 8192,
        candidateCount: 1
      },
      safetySettings: [
        {
          category: 'HARM_CATEGORY_HARASSMENT',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE'
        },
        {
          category: 'HARM_CATEGORY_HATE_SPEECH',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE'
        },
        {
          category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE'
        },
        {
          category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE'
        }
      ]
    });

    // Build context from user data
    const preferences = await getUserPreferences(userId);
    const memory = await getUserMemory(userId);
    
        // Build conversation context more intelligently
        const recentHistory = conversationHistory.slice(-6); // Last 3 exchanges
        const conversationContext = recentHistory.map(h => {
          if (h.memory_type === 'user_message') return `User: ${h.memory_content}`;
          if (h.memory_type === 'assistant_response') return `Assistant: ${h.memory_content}`;
          return `${h.memory_type}: ${h.memory_content}`;
        }).join('\n');
        
        // Check if user is asking for guidance on a previously learned recipe
        const savedRecipes = await getUserRecipes(userId, true); // Include full recipe data
        
        // Get the most recent recipe (likely just learned)
        const mostRecentRecipe = savedRecipes.length > 0 ? savedRecipes[0] : null;
        
        // Build recipe guidance context
        let recipeGuidanceContext = '';
        if (savedRecipes.length > 0) {
          recipeGuidanceContext = `\n\nSAVED RECIPES AVAILABLE FOR GUIDANCE:\n${savedRecipes.map(r => `- ${r.title} (${r.difficulty}, ${r.prep_time}min prep, ${r.cook_time}min cook)`).join('\n')}`;
          
          // If the most recent recipe was just learned (within last 5 minutes), provide FULL context
          if (mostRecentRecipe) {
            const recipeAge = Date.now() - new Date(mostRecentRecipe.created_at).getTime();
            if (recipeAge < 5 * 60 * 1000) { // 5 minutes
              recipeGuidanceContext += `\n\n⭐ MOST RECENTLY LEARNED RECIPE: "${mostRecentRecipe.title}"`;
              
              // Include full recipe details if available
              if (mostRecentRecipe.recipe_data) {
                const recipe = mostRecentRecipe.recipe_data;
                recipeGuidanceContext += `\n\nRECIPE DETAILS:`;
                recipeGuidanceContext += `\n- Description: ${recipe.description || 'N/A'}`;
                recipeGuidanceContext += `\n- Servings: ${recipe.servings || 'N/A'}`;
                recipeGuidanceContext += `\n- Difficulty: ${recipe.difficulty || 'N/A'}`;
                
                if (recipe.ingredients && recipe.ingredients.length > 0) {
                  recipeGuidanceContext += `\n\nINGREDIENTS (${recipe.ingredients.length} items):`;
                  recipe.ingredients.slice(0, 10).forEach((ing, i) => {
                    recipeGuidanceContext += `\n${i + 1}. ${ing.amount} ${ing.name}${ing.notes ? ` (${ing.notes})` : ''}`;
                  });
                }
                
                if (recipe.steps && recipe.steps.length > 0) {
                  recipeGuidanceContext += `\n\nSTEPS (${recipe.steps.length} total):`;
                  recipe.steps.slice(0, 5).forEach((step) => {
                    recipeGuidanceContext += `\n${step.step}. ${step.instruction}`;
                  });
                  if (recipe.steps.length > 5) {
                    recipeGuidanceContext += `\n... and ${recipe.steps.length - 5} more steps`;
                  }
                }
                
                recipeGuidanceContext += `\n\n✅ This recipe is ready for step-by-step guidance!`;
              }
            }
          }
        }
    
        const contextPrompt = `You are Chef Compadre, a helpful cooking assistant with access to user data and tools.

🚨🚨🚨 CRITICAL MANDATORY INSTRUCTION: 
If the user says ANYTHING about wanting to SEE, VIEW, SHOW, or LOOK AT something (including "show me", "can you show", "how does it look", "how it looks like", "what does it look like"), you MUST IMMEDIATELY call the show_reference_images function. 
- Extract the subject from their message or recent conversation (if they use "it", "that", "this", figure out what they mean from context)
- DO NOT respond with text description - ALWAYS use the tool first to show actual images!
- This is NOT optional - if they want to see something visual, you MUST call the tool.

USER CONTEXT:
${preferences.map(p => `- ${p.preference_type}: ${p.preference_value}`).join('\n')}
${memory.map(m => `- ${m.memory_content}`).join('\n')}

RECENT CONVERSATION:
${conversationContext}
${recipeGuidanceContext}

CURRENT MESSAGE: ${message}

INSTRUCTIONS:
- **CRITICAL**: Be conversational and maintain context throughout the ENTIRE conversation
- Remember EVERYTHING from the recent conversation history above
- **LEARNED RECIPES**: If a recipe was just learned (see ⭐ MOST RECENTLY LEARNED section):
  * You have FULL access to all ingredients, steps, times, difficulty
  * This recipe is NOW IN YOUR MEMORY - treat it as if you've always known it
  * When user asks about "the recipe" or "that recipe", they mean THIS one
  * Answer ALL questions directly from the recipe details above
  * Don't ask "which recipe?" - you already know!
  * Reference specific ingredients and amounts from the data provided
  * If they say "guide me" or "let's cook this", use the recipe data above

- **SAVED RECIPES** (listed above):
  * These are recipes the user has previously learned/saved
  * They can ask you about any of them
  * Recently learned recipes (⭐) have full details available
  * For older recipes, you may only have title/basic info

- **Use tools SMARTLY**:
  * show_reference_images: **MANDATORY - ALWAYS CALL THIS TOOL** when user says ANY of these:
    - "show me [X]" / "show [X]" / "show a picture" / "can you show me"
    - "picture of [X]" / "photo of [X]" / "image of [X]"
    - "what does [X] look like" / "how does [X] look" / "how it looks like" / "can you show me how it looks"
    - "I want to see [X]" / "can I see [X]" / "let me see [X]" / "see how it looks"
    - "reference for [X]" / "reference image" / "visual reference"
    - If user uses pronouns ("it", "that", "this"), extract what they're referring to from conversation context
    - DO NOT just describe visually - ALWAYS CALL THE TOOL so they can see actual images!
    - Example: User says "can you show me how it looks like" → Extract "it" from context (e.g., "fried rice") → Call tool with query="fried rice"
  * add_to_shopping_list: When user wants to save ingredients for later
  * save_recipe: ONLY for new recipes (learned recipes are already saved)
  * update_preferences: When user mentions dietary changes
  * suggest_substitutions: When user asks for alternatives
  * guide_recipe_step: For structured step-by-step cooking

- **DON'T use tools for**:
  * Answering questions (unless it's asking to SEE something - then use show_reference_images)
  * General conversation
  * Explaining things (unless they want to SEE - then use show_reference_images)
  * Just talk naturally!

- **Be SMART**:
  * Continue previous topics naturally
  * Don't repeat information
  * Reference earlier conversation
  * Act like you remember everything
  * Be concise and helpful
  * Don't suggest nutrition analysis - it happens automatically

Respond naturally as if you're having a continuous conversation with full memory and access to all learned recipes.`;

    const result = await model.generateContent(contextPrompt);
    const response = await result.response;
    
    // Monitor token usage
    const usageMetadata = response.usageMetadata;
    if (usageMetadata) {
      console.log('Token usage:', {
        promptTokens: usageMetadata.promptTokenCount,
        candidatesTokens: usageMetadata.candidatesTokenCount,
        totalTokens: usageMetadata.totalTokenCount
      });
      
      // Warn if approaching limits
      if (usageMetadata.totalTokenCount > 30000) {
        console.warn('⚠️ High token usage detected:', usageMetadata.totalTokenCount);
      }
    }
    
    // Check if response was blocked or truncated
    if (response.promptFeedback?.blockReason) {
      console.error('Response blocked:', response.promptFeedback.blockReason);
      throw new Error(`Content blocked: ${response.promptFeedback.blockReason}`);
    }
    
    // Check finish reason
    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      console.warn('⚠️ Response finish reason:', finishReason);
      if (finishReason === 'MAX_TOKENS') {
        console.error('Response truncated due to max tokens');
      } else if (finishReason === 'SAFETY') {
        console.error('Response blocked by safety filters');
      }
    }
    
    let reply = response.text();
    let actions = [];
    let nutritionData = null;
    
    // Check if LLM wants to use tools (support multiple SDK shapes)
    let functionCalls = [];
    try {
      if (typeof response.functionCalls === 'function') {
        // Newer SDK exposes functionCalls() accessor
        functionCalls = response.functionCalls() || [];
      } else if (Array.isArray(response.functionCalls)) {
        // Some SDK versions expose as a property
        functionCalls = response.functionCalls || [];
      }
      // Fallback: parse from candidate content parts
      if ((!functionCalls || functionCalls.length === 0) && Array.isArray(response.candidates)) {
        const parts = response.candidates?.[0]?.content?.parts || [];
        functionCalls = parts
          .filter(p => p && p.functionCall)
          .map(p => p.functionCall);
      }
    } catch (e) {
      console.warn('Function call extraction failed:', e);
    }

    if (functionCalls && functionCalls.length > 0) {
      console.log('🔧 LLM wants to use tools! Function calls:', functionCalls.length);
      for (const call of functionCalls) {
        console.log('🔧 Executing function call:', call.name, 'with args:', call.args);
        try {
          const result = await executeFunctionCall(userId, call);
          console.log('🔧 Function call result:', result);
          actions.push(result);
        } catch (error) {
          console.error('Function call error:', error);
          actions.push({ error: error.message });
        }
      }
      console.log('🔧 All actions after function calls:', actions);
    } else {
      console.log('ℹ️ No function calls from LLM - response snippet:', (reply || '').substring(0, 120));
    }
    
    // Fallback heuristic: If no tool calls and the user clearly asked to SEE something,
    // proactively create a reference_images action using the user's message as the query
    if (actions.length === 0) {
      const seePhrases = [
        'show me', 'show ', 'picture of', 'photo of', 'image of',
        'what does', 'how does', 'how it looks', 'how it looks like', 'how it look',
        'can i see', 'let me see', 'see how'
      ];
      const lowerMsg = (message || '').toLowerCase();
      const askedToSee = seePhrases.some(p => lowerMsg.includes(p));
      if (askedToSee) {
        // Try to extract a simple query: take everything after the trigger phrase
        let query = lowerMsg;
        for (const p of seePhrases) {
          if (query.includes(p)) {
            query = query.split(p).pop().trim();
          }
        }
        // Remove generic tails
        query = query.replace(/^how (it|this|that) looks?( like)?\s*/,'').trim();
        query = query.replace(/^(does|do) (it|this|that) look( like)?\s*/,'').trim();
        // If query still empty, fall back to last mentioned recipe/keyword from memory
        if (!query) {
          const lastMem = (memory || []).slice(-1)[0]?.memory_content || '';
          query = lastMem.split(/[\n,.]/)[0].trim() || 'biryani';
        }
        const action = {
          action: 'reference_images',
          query,
          reason: 'Heuristic fallback: user explicitly asked to SEE something'
        };
        console.log('🖼️ Heuristic fallback action created:', action);
        actions.push(action);
      }
    }

    // Check if user explicitly requested nutrition info
    const userExplicitlyAskedForNutrition = message && (
      message.toLowerCase().includes('nutrition') ||
      message.toLowerCase().includes('calories') ||
      message.toLowerCase().includes('how healthy') ||
      message.toLowerCase().includes('nutritional')
    );
    
    // Only analyze nutrition for NEW recipe suggestions, or explicit requests
    if (userExplicitlyAskedForNutrition || isNewRecipeSuggestion(reply, conversationHistory)) {
      try {
        console.log('🍎 Analyzing nutrition:', userExplicitlyAskedForNutrition ? 'explicit request' : 'new recipe detected');
        nutritionData = await analyzeNutrition(reply, 1);
      } catch (nutritionError) {
        console.error('Nutrition analysis failed:', nutritionError);
      }
    }
    
    const apiResponse = {
      reply,
      actions,
      nutrition: nutritionData
    };
    
    console.log('📤 Sending response with:', {
      replyLength: reply.length,
      actionsCount: actions.length,
      actions: actions,
      hasNutrition: !!nutritionData
    });
    
    return apiResponse;
    
  } catch (error) {
    console.error('Agent processing error:', error);
    return {
      reply: "I'm having trouble processing that right now. Please try again.",
      actions: [],
      nutrition: null
    };
  }
}

async function executeFunctionCall(userId, functionCall) {
  const { name, args } = functionCall;
  
  switch (name) {
    case 'add_to_shopping_list':
      return await executeAddToShoppingList(userId, args.items);
    case 'save_recipe':
      return await executeSaveRecipe(userId, args);
    case 'update_preferences':
      return await executeUpdatePreferences(userId, args);
    case 'suggest_substitutions':
      return await executeSuggestSubstitutions(userId, args);
    case 'guide_recipe_step':
      return await executeGuideRecipeStep(userId, args);
    case 'show_reference_images':
      return await executeShowReferenceImages(userId, args);
    default:
      return { error: 'Unknown function' };
  }
}

async function executeAddToShoppingList(userId, items) {
  try {
    const success = await addToShoppingList(userId, items);
    
    if (success) {
      return { 
        action: 'shopping_list_added', 
        items: items,
        message: `Added ${items.length} items to your shopping list` 
      };
    } else {
      throw new Error('Failed to add to shopping list');
    }
  } catch (error) {
    console.error('Shopping list error:', error);
    return { error: 'Failed to add to shopping list' };
  }
}

async function executeSaveRecipe(userId, recipeData) {
  try {
    const success = await saveRecipe(userId, recipeData);
    
    if (success) {
      return { 
        action: 'recipe_saved', 
        recipe: recipeData,
        message: `Saved recipe: ${recipeData.title}` 
      };
    } else {
      throw new Error('Failed to save recipe');
    }
  } catch (error) {
    console.error('Recipe save error:', error);
    return { error: 'Failed to save recipe' };
  }
}

async function executeUpdatePreferences(userId, preferenceData) {
  try {
    await saveUserPreference(userId, preferenceData.preference_type, preferenceData.preference_value, preferenceData.confidence || 3);
    return { 
      action: 'preference_updated', 
      preference: preferenceData,
      message: `Updated your ${preferenceData.preference_type} preference` 
    };
  } catch (error) {
    console.error('Preference update error:', error);
    return { error: 'Failed to update preference' };
  }
}

async function executeSuggestSubstitutions(userId, substitutionData) {
  try {
    return { 
      action: 'substitution_suggested', 
      substitution: substitutionData,
      message: `Suggested alternatives for ${substitutionData.original_ingredient}` 
    };
  } catch (error) {
    console.error('Substitution error:', error);
    return { error: 'Failed to suggest substitutions' };
  }
}

async function executeGuideRecipeStep(userId, stepData) {
  try {
    return { 
      action: 'recipe_step_guided', 
      step: stepData,
      message: `Step ${stepData.step_number}: ${stepData.step_description}` 
    };
  } catch (error) {
    console.error('Recipe guide error:', error);
    return { error: 'Failed to guide recipe step' };
  }
}

async function executeShowReferenceImages(userId, imageData) {
  try {
    console.log('🖼️ executeShowReferenceImages called with:', imageData);
    const result = { 
      action: 'reference_images', 
      query: imageData.query || 'cooking',
      reason: imageData.reason || 'User requested visual reference',
      message: `Opening reference images for: ${imageData.query || 'cooking'}` 
    };
    console.log('🖼️ Returning reference_images action:', result);
    return result;
  } catch (error) {
    console.error('Reference images error:', error);
    return { error: 'Failed to show reference images' };
  }
}

function isNewRecipeSuggestion(text, conversationHistory) {
  if (!text || typeof text !== 'string') return false;
  
  const lowerText = text.toLowerCase();
  
  // Skip questions
  if (lowerText.includes('?') || lowerText.startsWith('what ') || lowerText.startsWith('how ')) {
    console.log('❌ Not recipe suggestion: Is a question');
    return false;
  }
  
  // Check if this is a continuation of existing conversation (within last 2 exchanges)
  const recentMessages = conversationHistory.slice(-4);
  const hasRecentRecipe = recentMessages.some(h => 
    h.memory_content && (
      h.memory_content.toLowerCase().includes('fried rice') ||
      h.memory_content.toLowerCase().includes('nutrition') ||
      h.memory_content.toLowerCase().includes('📖')
    )
  );
  
  // If we're continuing the SAME recipe conversation, don't show nutrition again
  if (hasRecentRecipe) {
    console.log('❌ Not recipe suggestion: Continuing existing recipe conversation');
    return false;
  }
  
  // NEW SIMPLER LOGIC: Is this explaining how to cook something?
  // Look for cooking keywords + reasonable length
  const cookingKeywords = [
    'step', 'cook', 'fry', 'boil', 'bake', 'sauté', 'grill', 'roast', 
    'ingredient', 'recipe', 'prepare', 'heat', 'simmer', 'mix', 'stir',
    'first', 'then', 'next', 'add', 'pour', 'chop', 'dice', 'slice'
  ];
  
  const hasCookingContent = cookingKeywords.some(word => lowerText.includes(word));
  const isLongEnough = text.length > 100; // At least 100 characters
  
  // NEW: Detect specific recipe names (like "fried rice", "pasta", "curry")
  const recipeNames = [
    'fried rice', 'pasta', 'curry', 'soup', 'stew', 'salad', 'sandwich',
    'stir fry', 'roast', 'grilled', 'baked', 'pizza', 'burger', 'taco'
  ];
  const mentionsRecipe = recipeNames.some(recipe => lowerText.includes(recipe));
  
  // Show nutrition if:
  // 1. It's a cooking explanation (has cooking keywords + decent length)
  // 2. OR it mentions a specific recipe name
  if ((hasCookingContent && isLongEnough) || mentionsRecipe) {
    console.log('✅ IS recipe suggestion: Cooking content detected');
    return true;
  }
  
  console.log('❌ Not recipe suggestion: No cooking content detected');
  return false;
}

function isRecipeSuggestion(text) {
  if (!text || typeof text !== 'string') return false;
  
  const lowerText = text.toLowerCase();
  
  const recipeKeywords = [
    'recipe', 'ingredients', 'cook', 'bake', 'fry', 'boil', 'simmer',
    'preheat', 'oven', 'pan', 'pot', 'serves', 'servings', 'prep time',
    'cook time', 'total time', 'step 1', 'step 2', 'first', 'then',
    'add', 'mix', 'stir', 'combine', 'season', 'garnish'
  ];
  
  const cookingMethods = [
    'saute', 'roast', 'grill', 'steam', 'braise', 'poach', 'blanch',
    'caramelize', 'reduce', 'whisk', 'fold', 'knead', 'dice', 'chop',
    'slice', 'mince', 'grate', 'zest', 'juice'
  ];
  
  const hasRecipeKeywords = recipeKeywords.some(keyword => lowerText.includes(keyword));
  const hasCookingMethods = cookingMethods.some(method => lowerText.includes(method));
  const hasSteps = /\b(step|first|then|next|finally|lastly)\b/i.test(text);
  const hasMeasurements = /\d+\s*(cup|tbsp|tsp|oz|lb|g|kg|ml|l|inch|cm)/i.test(text);
  
  const indicators = [hasRecipeKeywords, hasCookingMethods, hasSteps, hasMeasurements];
  const indicatorCount = indicators.filter(Boolean).length;
  
  return indicatorCount >= 2;
}

// ==============================================
// MAIN HANDLER
// ==============================================
async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8');
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

async function getConversationHistory(userId) {
  if (!supabase) {
    console.warn('Supabase not configured, using in-memory storage');
    return conversationHistory.get(userId) || [];
  }
  
  // Skip database query for non-UUID user IDs (like 'demo-user')
  if (!isValidUUID(userId)) {
    console.log('Using in-memory storage for non-UUID user:', userId);
    return conversationHistory.get(userId) || [];
  }
  
  try {
    const userIdStr = String(userId);
    const { data, error } = await supabase
      .from('conversation_memory')
      .select('memory_content, memory_type, created_at')
      .eq('user_id', userIdStr)
      .order('created_at', { ascending: true })
      .limit(20);
    
    if (error) {
      console.error('Error fetching conversation history:', error);
      return conversationHistory.get(userId) || [];
    }
    
    return data || [];
  } catch (error) {
    console.error('Error in getConversationHistory:', error);
    return conversationHistory.get(userId) || [];
  }
}

async function addToHistory(userId, userMessage, botResponse) {
  // Always save to in-memory storage
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId);
  history.push(
    { memory_type: 'user_message', memory_content: userMessage, created_at: new Date().toISOString() },
    { memory_type: 'assistant_response', memory_content: botResponse, created_at: new Date().toISOString() }
  );
  if (history.length > 20) {
    history.splice(0, history.length - 20);
  }
  
  if (!supabase) {
    console.warn('Supabase not configured, using in-memory storage only');
    return;
  }
  
  // Skip database save for non-UUID user IDs (like 'demo-user')
  if (!isValidUUID(userId)) {
    console.log('Skipping database save for non-UUID user:', userId);
    return;
  }
  
  try {
    const userIdStr = String(userId);
    const { error: userError } = await supabase
      .from('conversation_memory')
      .insert([
        { user_id: userIdStr, memory_type: 'user_message', memory_content: userMessage },
        { user_id: userIdStr, memory_type: 'assistant_response', memory_content: botResponse }
      ]);
    
    if (userError) {
      console.error('Error saving conversation history:', userError);
    }
  } catch (error) {
    console.error('Error in addToHistory:', error);
  }
}

// Export the analyzeNutrition function for use by other modules
const exportedAnalyzeNutrition = analyzeNutrition;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    res.status(500).json({ error: 'Gemini API key not configured' });
    return;
  }

  try {
    const { user_id = 'web', text = '' } = await readJson(req);
    console.log('Received request:', { user_id, text: text.substring(0, 100) });
    
    if (!text.trim()) {
      console.log('Empty text, returning empty response');
      res.status(200).json({ reply: '' });
      return;
    }

    // Validate input for safety
    const validation = validateInput(text);
    console.log('Input validation result:', validation);
    
    if (!validation.safe) {
      logSafetyViolation(user_id, text, validation.reason, validation.category);
      console.log('Input blocked by safety guardrails');
      res.status(400).json({ 
        error: 'Content blocked', 
        message: 'I can only help with cooking and food-related questions. Please ask me about recipes, ingredients, or cooking techniques!',
        reason: validation.reason
      });
      return;
    }

    // Get conversation history for context
    const conversationHistory = await getConversationHistory(user_id);
    console.log('Conversation history length:', conversationHistory.length);

    // Use the agentic conversation processor
    const result = await processWithAgent(user_id, text, conversationHistory);
    
    // Store conversation in database
    await addToHistory(user_id, text, result.reply);

    console.log('Sending response:', result.reply.substring(0, 100));
    console.log('Actions taken:', result.actions);
    
    res.setHeader('Content-Type', 'application/json');
    
    // Include nutrition data and actions if available
    const responseData = { 
      reply: result.reply,
      actions: result.actions || []
    };
    
    if (result.nutrition) {
      responseData.nutrition = result.nutrition;
    }
    
    res.status(200).json(responseData);
    
  } catch (error) {
    console.error('Conversation error:', error);
    
    // Provide a helpful fallback response for cooking-related queries
    let fallbackReply = "I'm having trouble connecting to my cooking knowledge right now. ";
    
    // Try to get text from request for context-aware fallback
    let text = '';
    try {
      const body = await readJson(req);
      text = body.text || '';
    } catch (parseError) {
      console.error('Error parsing request in catch block:', parseError);
    }
    
    if (text.toLowerCase().includes('vegetarian') || text.toLowerCase().includes('vegan')) {
      fallbackReply += "For vegetarian options, try making a delicious veggie stir-fry with your favorite vegetables, or a hearty bean and vegetable soup!";
    } else if (text.toLowerCase().includes('bread')) {
      fallbackReply += "For bread-based recipes, you could make garlic bread, bruschetta, or a simple grilled cheese sandwich!";
    } else if (text.toLowerCase().includes('healthy')) {
      fallbackReply += "For healthy cooking, focus on fresh vegetables, lean proteins, and whole grains. Try steaming or roasting your ingredients!";
    } else {
      fallbackReply += "Try asking me about specific ingredients you have, or what you'd like to cook today!";
    }
    
    res.status(200).json({ reply: fallbackReply });
  }
};

// Export the analyzeNutrition function for use by other modules
module.exports.analyzeNutrition = exportedAnalyzeNutrition;
