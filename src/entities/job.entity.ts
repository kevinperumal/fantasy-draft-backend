import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

// Lifecycle state — what the queue system cares about
export enum JobStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELED = 'canceled',
}

// Operational phase — what the UI reports to the user
export enum JobPhase {
  STARTING = 'starting',
  LOGGING_IN = 'logging_in',
  WAITING_ROOM = 'waiting_room',
  DRAFT_LIVE = 'draft_live',
  COMPLETED = 'completed',
  ERROR = 'error',
}

@Entity('jobs')
export class Job {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  draftId: string;

  @ManyToOne('Draft', 'jobs')
  @JoinColumn({ name: 'draftId' })
  draft: any;

  // Denormalized — lets the worker query by userId without a join
  @Column()
  userId: string;

  @Column({
    type: 'enum',
    enum: JobStatus,
    default: JobStatus.QUEUED,
  })
  status: JobStatus;

  @Column({
    type: 'enum',
    enum: JobPhase,
    nullable: true,
  })
  phase: JobPhase | null;

  // Timestamp set when the worker atomically claims this job
  @Column({ type: 'timestamptz', nullable: true })
  claimedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
