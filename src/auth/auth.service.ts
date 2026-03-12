import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { User } from '../entities/user.entity';

export interface JwtPayload {
  sub: string;
  username: string;
}

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  // Seed the two known users on every startup if they don't already exist.
  // Passwords come from env vars so they're never stored in source.
  async onApplicationBootstrap() {
    await this.seedUser(
      this.config.getOrThrow<string>('USER1_USERNAME'),
      this.config.getOrThrow<string>('USER1_PASSWORD'),
    );
    await this.seedUser(
      this.config.getOrThrow<string>('USER2_USERNAME'),
      this.config.getOrThrow<string>('USER2_PASSWORD'),
    );
  }

  private async seedUser(username: string, password: string) {
    const existing = await this.userRepo.findOne({ where: { username } });
    if (existing) return;
    const passwordHash = await bcrypt.hash(password, 12);
    await this.userRepo.save(this.userRepo.create({ username, passwordHash }));
    console.log(`[Auth] Seeded user: ${username}`);
  }

  async validateUser(username: string, password: string): Promise<User | null> {
    const user = await this.userRepo.findOne({ where: { username } });
    if (!user) return null;
    const valid = await bcrypt.compare(password, user.passwordHash);
    return valid ? user : null;
  }

  signToken(user: User): string {
    const payload: JwtPayload = { sub: user.id, username: user.username };
    return this.jwtService.sign(payload);
  }

  verifyToken(token: string): JwtPayload | null {
    try {
      return this.jwtService.verify<JwtPayload>(token);
    } catch {
      return null;
    }
  }
}
