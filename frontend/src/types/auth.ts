export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  assigned_pipeline?: string;
}

export interface LoginResponse {
  success: boolean;
  token: string;
  user: AuthUser;
}
