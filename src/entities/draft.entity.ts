import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';

export enum DraftStatus {
  ACTIVE = 'active',
  COMPLETED = 'completed',
  CANCELED = 'canceled',
}

@Entity('drafts')
export class Draft {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @ManyToOne('User', 'drafts')
  @JoinColumn({ name: 'userId' })
  user: any;

  @Column()
  leagueId: string;

  @Column({ default: 'baseball' })
  sport: string;

  // Provisioned Google Sheet URL for this draft
  @Column({ nullable: true, type: 'text' })
  sheetUrl: string;

  // ESPN fantasy team name for the user (used for AI roster tracking)
  @Column({ nullable: true, type: 'text' })
  espnTeamName: string | null;

  // Number of teams in the league (used for snake draft pick calculation)
  @Column({ nullable: true, type: 'int' })
  leagueSize: number | null;

  @Column({
    type: 'enum',
    enum: DraftStatus,
    default: DraftStatus.ACTIVE,
  })
  status: DraftStatus;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany('Job', 'draft')
  jobs: any[];
}
