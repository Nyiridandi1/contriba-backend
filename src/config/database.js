const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = 'https://etswwbmrfqeokmobvhwy.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV0c3d3Ym1yZnFlb2ttb2J2aHd5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTI3MDQ4NSwiZXhwIjoyMDk2ODQ2NDg1fQ.GKEgOUX2XeL7yKx8yIgKzx3WuhB-VAA0-W7t9pTlnvM';

const supabase = createClient(supabaseUrl, supabaseKey);

// Test connection
async function testConnection() {
  try {
    const { data, error } = await supabase.from('users').select('count');
    if (error) throw error;
    console.log('Database connected successfully!');
  } catch (err) {
    console.error('Database connection error:', err.message);
  }
}

testConnection();

module.exports = supabase;