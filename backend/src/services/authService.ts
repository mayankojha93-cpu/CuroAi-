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
  assigned_pipeline: string;
}

export class AuthService {
  /**
   * Automatically ensure default admin users exist for each pipeline
   */
  async ensureDefaultAdmin(): Promise<void> {
    try {
      // 1. Ensure Airtel Admin exists with pipeline = 'airtel'
      const airtelEmail = (env.DEFAULT_ADMIN_EMAIL || 'admin@curoai.in').toLowerCase().trim();
      const existingAirtel = await pool.query('SELECT id, assigned_pipeline FROM users WHERE email = $1', [airtelEmail]);
      if (existingAirtel.rows.length === 0) {
        logger.info({ email: airtelEmail }, 'Seeding default Airtel admin user...');
        const passwordHash = await bcrypt.hash(env.DEFAULT_ADMIN_PASSWORD || 'admin12345', 10);
        await pool.query(
          `INSERT INTO users (email, password_hash, full_name, role, assigned_pipeline, is_active)
           VALUES ($1, $2, $3, $4, 'airtel', true)`,
          [airtelEmail, passwordHash, 'Airtel Telecom Admin', 'admin']
        );
        logger.info({ email: airtelEmail }, 'Default Airtel admin user seeded successfully');
      } else if (existingAirtel.rows[0].assigned_pipeline !== 'airtel') {
        await pool.query(`UPDATE users SET assigned_pipeline = 'airtel', full_name = 'Airtel Telecom Admin' WHERE email = $1`, [airtelEmail]);
      }

      // 2. Ensure Real Estate Admin exists with pipeline = 'real_estate'
      const estateEmail = 'estate.admin@curoai.in';
      const existingEstate = await pool.query('SELECT id, assigned_pipeline FROM users WHERE email = $1', [estateEmail]);
      if (existingEstate.rows.length === 0) {
        logger.info({ email: estateEmail }, 'Seeding 2nd pipeline Real Estate admin user...');
        const estateHash = await bcrypt.hash('admin12345', 10);
        await pool.query(
          `INSERT INTO users (email, password_hash, full_name, role, assigned_pipeline, is_active)
           VALUES ($1, $2, $3, $4, 'real_estate', true)`,
          [estateEmail, estateHash, 'My Estate Finder Admin', 'admin']
        );
        logger.info({ email: estateEmail }, 'Real estate admin user seeded successfully');
      } else if (existingEstate.rows[0].assigned_pipeline !== 'real_estate') {
        await pool.query(`UPDATE users SET assigned_pipeline = 'real_estate', full_name = 'My Estate Finder Admin' WHERE email = $1`, [estateEmail]);
      }
    } catch (err) {
      logger.error({ err }, 'Failed to check/seed default admin users');
    }
  }

  /**
   * Authenticate user with email and password
   */
  async login(emailInput: string, passwordInput: string): Promise<{ token: string; user: UserPayload }> {
    const email = emailInput.toLowerCase().trim();
    const query = `
      SELECT id, email, password_hash, full_name, role, assigned_pipeline, is_active
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
      assigned_pipeline: userRow.assigned_pipeline || (userRow.email.includes('estate') ? 'real_estate' : 'airtel'),
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
      'SELECT id, email, full_name, role, assigned_pipeline, is_active FROM users WHERE id = $1',
      [id]
    );
    const userRow = res.rows[0];
    if (!userRow || !userRow.is_active) return null;

    return {
      id: userRow.id,
      email: userRow.email,
      name: userRow.full_name,
      role: userRow.role,
      assigned_pipeline: userRow.assigned_pipeline || (userRow.email.includes('estate') ? 'real_estate' : 'airtel'),
    };
  }
}

export const authService = new AuthService();
