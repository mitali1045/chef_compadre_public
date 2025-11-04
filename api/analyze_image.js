// api/analyze_image.js
// Image analysis using Gemini's vision capabilities

const { GoogleGenerativeAI } = require('@google/generative-ai');
const formidable = require('formidable');
const fs = require('fs').promises;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function parseFormData(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: false,
      keepExtensions: true,
      maxFileSize: 10 * 1024 * 1024 // 10MB
    });
    
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
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
    // Parse the form data
    const { fields, files } = await parseFormData(req);
    
    // Get the image file
    const imageFile = files.image?.[0] || files.image;
    if (!imageFile) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    // Get the prompt
    const prompt = fields.prompt?.[0] || fields.prompt || 'Analyze this cooking-related image and provide helpful information.';

    console.log('Analyzing image:', imageFile.originalFilename || imageFile.newFilename);

    // Read the image file
    const imageBuffer = await fs.readFile(imageFile.filepath);
    
    // Convert to base64
    const base64Image = imageBuffer.toString('base64');
    
    // Determine mime type
    const mimeType = imageFile.mimetype || 'image/jpeg';

    // Use Gemini Vision API
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });

    const imagePart = {
      inlineData: {
        data: base64Image,
        mimeType: mimeType
      }
    };

    const result = await model.generateContent([
      `You are a cooking expert. ${prompt}. Be specific about what you see, cooking techniques, doneness, substitutions, or any cooking advice. Keep it concise and practical.`,
      imagePart
    ]);

    const response = await result.response;
    const analysis = response.text();

    // Clean up the uploaded file
    try {
      await fs.unlink(imageFile.filepath);
    } catch (unlinkError) {
      console.error('Failed to delete temp file:', unlinkError);
    }

    return res.status(200).json({ 
      analysis,
      success: true
    });
    
  } catch (error) {
    console.error('Image analysis error:', error);
    return res.status(500).json({ 
      error: 'Image analysis failed', 
      details: error.message 
    });
  }
};
