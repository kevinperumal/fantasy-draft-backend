import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('picks')
export class PickRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  draftId: string;

  @Column({ nullable: true })
  leagueId: string;

  @Column()
  player: string;

  @Column({ nullable: true })
  nflTeam: string;

  @Column({ nullable: true })
  position: string;

  // ESPN fantasy team name that made this pick (best-effort from DOM)
  @Column({ nullable: true })
  pickerTeam: string;

  // 1-based overall pick number (derived server-side from count)
  @Column({ nullable: true })
  overallPick: number;

  @CreateDateColumn()
  createdAt: Date;
}
