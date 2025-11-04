// Authentication API endpoint - Simple Email/Password System
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (supabaseUrl && supabaseAnonKey) {
  supabase = createClient(supabaseUrl, supabaseAnonKey);
  console.log('Supabase client initialized');
}

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(500).json({ 
      error: 'Supabase not configured', 
      details: 'Check SUPABASE_URL and SUPABASE_ANON_KEY environment variables'
    });
  }

  try {
    const { action, email, password, token } = req.body;

    switch (action) {
      case 'send_magic_link':
        if (!email) {
          return res.status(400).json({ error: 'Email required' });
        }
        
        // Use production URL for magic link redirect
        const redirectUrl = process.env.MAGIC_LINK_REDIRECT_URL || 'https://chef-compadre.vercel.app/';
        console.log('Auth redirect URL:', redirectUrl);
        
        const { error: linkError } = await supabase.auth.signInWithOtp({
          email,
          options: {
            emailRedirectTo: redirectUrl
          }
        });
        
        if (linkError) {
          return res.status(400).json({ error: linkError.message });
        }
        
        return res.json({ message: 'Magic link sent!' });

      case 'sign_out':
        const { error: signOutError } = await supabase.auth.signOut();
        
        if (signOutError) {
          return res.status(400).json({ error: signOutError.message });
        }
        
        return res.json({ message: 'Signed out successfully' });

      default:
        return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
