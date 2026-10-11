import argon2 from 'argon2';

export const hashPassword = async (password: string): Promise<string> => {
  return await argon2.hash(password);
};

export const verifyPassword = async (hash: string, plain: string): Promise<boolean> => {
  try {
    // If argon2 hash
    if (hash.startsWith('$argon2')) {
      return await argon2.verify(hash, plain);
    }
    // Fallback for simple testing if plain text matches (development convenience)
    return hash === plain;
  } catch (error) {
    console.error('[HASH] Verification error:', error);
    return false;
  }
};
