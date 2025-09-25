import axios from 'axios';
import { config } from '../config.js';
import { callLaravelAPI } from './api.js';

export class AuthService {
  constructor(sessionStore) {
    this.sessions = sessionStore;
  }

  getRegistrationLink() {
    return `${config.LARAVEL_BASE_URL}/api/user/register`;
  }

  async login(chatId, { email, password }) {
    if (!config.LARAVEL_BASE_URL) return { error: 'API not configured' };

    const reqConfig = {
      method: 'POST',
      baseURL: config.LARAVEL_BASE_URL,
      url: '/api/user/login',
      headers: { 'Content-Type': 'application/json' },
      data: { email, password },
      timeout: 15000,
      validateStatus: (s) => s >= 200 && s < 300,
    };

    // Diagnostic log (password not logged)
    console.log('[AuthService::login] Request -->', {
      baseURL: reqConfig.baseURL,
      url: reqConfig.url,
      email,
      hasPassword: Boolean(password),
    });

    try {
      const resp = await axios(reqConfig);
      const data = resp.data;
      console.log('[AuthService::login] Response status -->', resp.status);
      const token = data?.response?.token;
      const user = data?.response?.user;
      if (!token || !user) {
        return { error: data?.message || 'Login failed' };
      }
      const sess = this.sessions.get(chatId);
      sess.auth = { isAuthed: true, accessToken: token, user, email };
      this.sessions.set(chatId, sess);
      return { token, user };
    } catch (err) {
      // Rich diagnostics
      if (err.response) {
        console.error('[AuthService::login] Axios response error', {
          status: err.response.status,
          data: err.response.data,
        });
        const { status, data } = err.response;
        return { error: data?.message || data?.error || `Login error ${status}` };
      }
      if (err.request) {
        console.error('[AuthService::login] Axios request error (no response)', {
          code: err.code,
          message: err.message,
        });
        return { error: 'Network error: no response from API' };
      }
      console.error('[AuthService::login] Axios config/runtime error', {
        code: err.code,
        message: err.message,
      });
      return { error: err.message || 'Unexpected error' };
    }
  }

  async verifyPin(chatId, { email, pin }) {
    if (!config.LARAVEL_BASE_URL) return { error: 'API not configured' };
    const sess = this.sessions.get(chatId);
    const token = sess?.auth?.accessToken;
    if (!token) return { error: 'Not authenticated. Please login first.' };

    try {
      const resp = await axios({
        method: 'POST',
        baseURL: config.LARAVEL_BASE_URL,
        url: '/api/user/pin/auth',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        data: { email, pin },
        timeout: 15000,
      });
      const data = resp.data;
      if (data?.success !== true) {
        return { error: data?.message || 'PIN verification failed' };
      }
      // Mark as pinVerified if you want stricter checks for sensitive ops
      sess.auth = { ...sess.auth, pinVerified: true };
      this.sessions.set(chatId, sess);
      return { ok: true };
    } catch (err) {
      if (err.response) {
        const { status, data } = err.response;
        return { error: data?.message || data?.error || `PIN error ${status}` };
      }
      if (err.request) return { error: 'Network error: no response from API' };
      return { error: err.message || 'Unexpected error' };
    }
  }

  async registerUser(chatId, payload) {
    const session = this.sessions.get(chatId);
    // Try the typical API route first
    let res = await callLaravelAPI('/user/register', chatId, 'POST', payload, { session });
    if (res?.error) {
      // Fallback to /register if the first is not available
      res = await callLaravelAPI('/register', chatId, 'POST', payload, { session });
    }

    // On success, save auth token if returned
    if (!res?.error && (res?.token || res?.access_token || res?.response?.token)) {
      const token = res.token || res.access_token || res.response?.token;
      const user = res.user || res.response?.user || null;
      this.sessions.set(chatId, {
        ...session,
        auth: {
          ...(session?.auth || {}),
          isAuthed: true,
          accessToken: token,
          email: payload.email || user?.email || null,
          user: user || session?.auth?.user,
        },
      });
    }
    return res;
  }
}
