import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

// Decorate a route or controller with @Public() to bypass JWT auth
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
