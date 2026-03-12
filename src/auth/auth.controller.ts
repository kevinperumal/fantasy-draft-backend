import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';

class LoginDto {
  username: string;
  password: string;
}

const COOKIE_NAME = 'auth_token';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const IS_PROD = process.env.NODE_ENV === 'production';

// Cross-origin cookie config (Vercel frontend → Railway backend).
// sameSite: 'none' is required for cross-origin cookies; it mandates secure: true.
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: (IS_PROD ? 'none' : 'lax') as 'none' | 'lax',
  maxAge: COOKIE_MAX_AGE_MS,
};

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('login')
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.authService.validateUser(body.username, body.password);
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const token = this.authService.signToken(user);
    res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);

    return { ok: true, username: user.username };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
    return { ok: true };
  }

  // Used by the frontend on load to check whether the session is still valid
  @Get('me')
  me(@Req() req: Request & { user: { sub: string; username: string } }) {
    return { id: req.user.sub, username: req.user.username };
  }
}
