import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(cookieParser());

  const allowedOrigin = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';
  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. server-to-server) or from ESPN (injected script)
      if (!origin || origin === allowedOrigin || origin.endsWith('.espn.com') || origin.endsWith('.espn.net')) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });
  await app.listen(process.env.PORT || 3000);
}
bootstrap();
