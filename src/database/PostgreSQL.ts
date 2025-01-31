import {DbLoadCallback, IDatabase} from './IDatabase';
import {Game, GameOptions, Score} from '../Game';
import {GameId} from '../common/Types';
import {SerializedGame} from '../SerializedGame';

import {Pool, ClientConfig, QueryResult} from 'pg';

export class PostgreSQL implements IDatabase {
  protected client: Pool;
  private databaseName: string | undefined = undefined; // Use this only for stats.

  constructor(
    config: ClientConfig = {
      connectionString: process.env.POSTGRES_HOST,
    }) {
    if (config.connectionString !== undefined && config.connectionString.startsWith('postgres')) {
      config.ssl = {
        // heroku uses self-signed certificates
        rejectUnauthorized: false,
      };
    }

    if (config.database) {
      this.databaseName = config.database;
    } else if (config.connectionString) {
      try {
        // Remove leading / from pathname.
        this.databaseName = new URL(config.connectionString).pathname.replace(/^\//, '');
      } catch (e) {
        console.log(e);
      }
    }
    // Configuration stats saved for
    this.client = new Pool(config);
  }

  public initialize(): Promise<QueryResult<any>> {
    return this.client.query('CREATE TABLE IF NOT EXISTS games(game_id varchar, players integer, save_id integer, game text, status text default \'running\', created_time timestamp default now(), PRIMARY KEY (game_id, save_id))')
      .then(() => this.client.query('CREATE TABLE IF NOT EXISTS game_results(game_id varchar not null, seed_game_id varchar, players integer, generations integer, game_options text, scores text, PRIMARY KEY (game_id))'))
      .then(() => this.client.query('CREATE INDEX IF NOT EXISTS games_i1 on games(save_id)'))
      .then(() => this.client.query('CREATE INDEX IF NOT EXISTS games_i2 on games(created_time)'))
      .catch((err) => {
        throw err;
      });
  }

  getPlayerCount(game_id: GameId, cb: (err: Error | undefined, playerCount: number | undefined) => void) {
    const sql = 'SELECT players FROM games WHERE save_id = 0 AND game_id = $1 LIMIT 1';

    this.client.query(sql, [game_id], (err, res) => {
      if (err) {
        console.error('PostgreSQL:getPlayerCount', err);
        cb(err, undefined);
        return;
      }
      if (res.rows.length === 0) {
        cb(undefined, undefined);
        return;
      }
      cb(undefined, res.rows[0].players);
    });
  }

  getGames(): Promise<Array<GameId>> {
    const sql: string = 'SELECT games.game_id FROM games, (SELECT max(save_id) save_id, game_id FROM games WHERE status=\'running\' GROUP BY game_id) a WHERE games.game_id = a.game_id AND games.save_id = a.save_id ORDER BY created_time DESC';
    return this.client.query(sql)
      .then((res) => {
        return res.rows.map((row) => row.game_id);
      }).catch((err) => {
        console.error('PostgreSQL:getGames', err);
        throw err;
      });
  }

  loadCloneableGame(game_id: GameId): Promise<SerializedGame> {
    // Retrieve first save from database
    return this.client.query('SELECT game_id, game FROM games WHERE game_id = $1 AND save_id = 0', [game_id])
      .then((res) => {
        if (res.rows.length === 0) {
          throw new Error(`Game ${game_id} not found`);
        }
        const json = JSON.parse(res.rows[0].game);
        return json;
      });
  }

  getGame(game_id: GameId, cb: (err: Error | undefined, game?: SerializedGame) => void): void {
    // Retrieve last save from database
    this.client.query('SELECT game game FROM games WHERE game_id = $1 ORDER BY save_id DESC LIMIT 1', [game_id], (err, res) => {
      if (err) {
        console.error('PostgreSQL:getGame', err);
        return cb(err);
      }
      if (res.rows.length === 0 || res.rows[0] === undefined) {
        return cb(new Error('Game not found'));
      }
      cb(undefined, JSON.parse(res.rows[0].game));
    });
  }

  // TODO(kberg): throw an error if two game ids exist.
  getGameId(id: string, cb: (err: Error | undefined, gameId?: GameId) => void): void {
    let sql = undefined;
    if (id.charAt(0) === 'p') {
      sql =
        `SELECT game_id
          FROM games, json_array_elements(CAST(game AS JSON)->'players') AS e
          WHERE save_id = 0 AND e->>'id' = $1`;
    } else if (id.charAt(0) === 's') {
      sql =
        `SELECT game_id
        FROM games
        WHERE save_id = 0 AND CAST(game AS JSON)->>'spectatorId' = $1`;
    } else {
      throw new Error(`id ${id} is neither a player id or spectator id`);
    }

    this.client.query(sql, [id], (err: Error | null, res: QueryResult<any>) => {
      if (err) {
        console.error('PostgreSQL:getGameId', err);
        return cb(err ?? undefined);
      }
      if (res.rowCount === 0) {
        return cb(new Error(`Game for player id ${id} not found`));
      }
      const gameId = res.rows[0].game_id;
      cb(undefined, gameId);
    });
  }

  public async getSaveIds(gameId: GameId): Promise<Array<number>> {
    const res = await this.client.query('SELECT distinct save_id FROM games WHERE game_id = $1', [gameId]);
    const allSaveIds: Array<number> = [];
    res.rows.forEach((row) => {
      allSaveIds.push(row.save_id);
    });
    return Promise.resolve(allSaveIds);
  }

  getGameVersion(game_id: GameId, save_id: number): Promise<SerializedGame> {
    return this.client.query('SELECT game game FROM games WHERE game_id = $1 and save_id = $2', [game_id, save_id])
      .then((res) => {
        if (res.rowCount === 0) {
          throw new Error(`Game ${game_id} not found at save_id ${save_id}`);
        }
        return JSON.parse(res.rows[0].game);
      });
  }

  saveGameResults(game_id: GameId, players: number, generations: number, gameOptions: GameOptions, scores: Array<Score>): void {
    this.client.query('INSERT INTO game_results (game_id, seed_game_id, players, generations, game_options, scores) VALUES($1, $2, $3, $4, $5, $6)', [game_id, gameOptions.clonedGamedId, players, generations, gameOptions, JSON.stringify(scores)], (err) => {
      if (err) {
        console.error('PostgreSQL:saveGameResults', err);
        throw err;
      }
    });
  }

  getMaxSaveId(game_id: GameId, cb: DbLoadCallback<number>): void {
    this.client.query('SELECT MAX(save_id) as save_id FROM games WHERE game_id = $1', [game_id], (err: Error | null, res: QueryResult<any>) => {
      if (err) {
        return cb(err ?? undefined, undefined);
      }
      cb(undefined, res.rows[0].save_id);
    });
  }

  throwIf(err: any, condition: string) {
    if (err) {
      console.error('PostgreSQL', condition, err);
      throw err;
    }
  }

  cleanSaves(game_id: GameId): void {
    this.getMaxSaveId(game_id, ((err, save_id) => {
      this.throwIf(err, 'cleanSaves0');
      if (save_id === undefined) throw new Error('saveId is undefined for ' + game_id);
      // DELETE all saves except initial and last one
      this.client.query('DELETE FROM games WHERE game_id = $1 AND save_id < $2 AND save_id > 0', [game_id, save_id], (err) => {
        this.throwIf(err, 'cleanSaves1');
        // Flag game as finished
        this.client.query('UPDATE games SET status = \'finished\' WHERE game_id = $1', [game_id], (err2) => {
          this.throwIf(err2, 'cleanSaves2');
          // Purge after setting the status as finished so it does not delete the game.
          this.purgeUnfinishedGames();
        });
      });
    }));
  }

  // Purge unfinished games older than MAX_GAME_DAYS days. If this environment variable is absent, it uses the default of 10 days.
  purgeUnfinishedGames(maxGameDays: string | undefined = process.env.MAX_GAME_DAYS): void {
    const envDays = parseInt(maxGameDays || '');
    const days = Number.isInteger(envDays) ? envDays : 10;
    this.client.query('DELETE FROM games WHERE created_time < now() - interval \'1 day\' * $1', [days], function(err?: Error, res?: QueryResult<any>) {
      if (res) {
        console.log(`Purged ${res.rowCount} rows`);
      }
      if (err) {
        return console.warn(err.message);
      }
    });
  }

  restoreGame(game_id: GameId, save_id: number, cb: DbLoadCallback<Game>): void {
    // Retrieve last save from database
    this.client.query('SELECT game game FROM games WHERE game_id = $1 AND save_id = $2 ORDER BY save_id DESC LIMIT 1', [game_id, save_id], (err, res) => {
      if (err) {
        console.error('PostgreSQL:restoreGame', err);
        cb(err, undefined);
        return;
      }
      if (res.rows.length === 0) {
        console.error('PostgreSQL:restoreGame', `Game ${game_id} not found`);
        cb(err, undefined);
        return;
      }
      try {
        // Transform string to json
        const json = JSON.parse(res.rows[0].game);
        const game = Game.deserialize(json);
        cb(undefined, game);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        cb(error, undefined);
      }
    });
  }

  async saveGame(game: Game): Promise<void> {
    const gameJSON = game.toJSON();
    return this.client.query(
      'INSERT INTO games (game_id, save_id, game, players) VALUES ($1, $2, $3, $4) ON CONFLICT (game_id, save_id) DO UPDATE SET game = $3',
      [game.id, game.lastSaveId, gameJSON, game.getPlayers().length])
      .then((_ignored) => {
        game.lastSaveId++;
      })
      .catch((err) => {
        console.error('PostgreSQL:saveGame', err);
      });
  }

  deleteGameNbrSaves(game_id: GameId, rollbackCount: number): void {
    if (rollbackCount > 0) {
      this.client.query('DELETE FROM games WHERE ctid IN (SELECT ctid FROM games WHERE game_id = $1 ORDER BY save_id DESC LIMIT $2)', [game_id, rollbackCount], (err) => {
        if (err) {
          return console.warn(err.message);
        }
      });
    }
  }

  public async stats(): Promise<{[key: string]: string | number}> {
    const map: {[key: string]: string | number}= {
      'type': 'POSTGRESQL',
      'pool-total-count': this.client.totalCount,
      'pool-idle-count': this.client.idleCount,
      'pool-waiting-count': this.client.waitingCount,
    };

    // TODO(kberg): return row counts
    return this.client.query(`
    SELECT
      pg_size_pretty(pg_total_relation_size(\'games\')) as game_size,
      pg_size_pretty(pg_total_relation_size(\'game_results\')) as game_result_size,
      pg_size_pretty(pg_database_size($1)) as db_size
    `, [this.databaseName])
      .then((result) => {
        map['size-bytes-games'] = result.rows[0].game_size;
        map['size-bytes-game-results'] = result.rows[0].game_result_size;
        map['size-bytes-database'] = result.rows[0].db_size;
        return map;
      });
  }
}
