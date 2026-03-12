import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';

class LoginDto {
  username: string;
  password: string;
}

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('login')
  async login(@Body() body: LoginDto) {
    const user = await this.authService.validateUser(body.username, body.password);
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const token = this.authService.signToken(user);
    return { ok: true, username: user.username, token };
  }

  @Post('logout')
  logout() {
    return { ok: true };
  }

  // Used by the frontend on load to check whether the session is still valid
  @Get('me')
  me(@Req() req: Request & { user: { sub: string; username: string } }) {
    return { id: req.user.sub, username: req.user.username };
  }
}
