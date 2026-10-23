import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db/index.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export interface UserPayload {
  id: string;
  email: string;
  name: string;
  role: string;
}

export class AuthService {
  /**
   * Automatically ensure a default admin user exists
   */
  async ensureDefaultAdmin(): Promise<void> {
    try {
      const email = env.DEFAULT_ADMIN_EMAIL.toLowerCase().trim();
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length === 0) {
        logger.info({ email }, 'Seeding default admin user...');
        const passwordHash = await bcrypt.hash(env.DEFAULT_ADMIN_PASSWORD, 10);
        await pool.query(
          `INSERT INTO users (email, password_hash, full_name, role, is_active)
           VALUES ($1, $2, $3, $4, true)`,
          [email, passwordHash, 'Airtel AI Admin', 'admin']
        );
        logger.info({ email }, 'Default admin user seeded successfully');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to check/seed default admin user');
    }
  }

  /**
   * Authenticate user with email and password
   */
  async login(emailInput: string, passwordInput: string): Promise<{ token: string; user: UserPayload }> {
    const email = emailInput.toLowerCase().trim();
    const query = `
      SELECT id, email, password_hash, full_name, role, is_active
      FROM users
      WHERE email = $1
    `;
    const res = await pool.query(query, [email]);
    const userRow = res.rows[0];

    if (!userRow || !userRow.is_active) {
      throw new Error('Invalid email or password');
    }

    const isMatch = await bcrypt.compare(passwordInput, userRow.password_hash);
    if (!isMatch) {
      throw new Error('Invalid email or password');
    }

    // Update last login timestamp in background
    pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [userRow.id]).catch(() => {});

    const user: UserPayload = {
      id: userRow.id,
      email: userRow.email,
      name: userRow.full_name,
      role: userRow.role,
    };

    const token = jwt.sign(user, env.JWT_SECRET, {
      expiresIn: env.JWT_EXPIRES_IN,
    } as jwt.SignOptions);

    return { token, user };
  }

  /**
   * Get user profile by ID for session validation
   */
  async getUserById(id: string): Promise<UserPayload | null> {
    const res = await pool.query(
      'SELECT id, email, full_name, role, is_active FROM users WHERE id = $1',
      [id]
    );
    const userRow = res.rows[0];
    if (!userRow || !userRow.is_active) return null;

    return {
      id: userRow.id,
      email: userRow.email,
      name: userRow.full_name,
      role: userRow.role,
    };
  }
}

export const authService = new AuthService();
