"""Vectorized client for the bot arena (stdlib only; returns numpy arrays if numpy is installed).

    env = Arena(num_envs=256, opponent="bot", frameSkip=4)
    obs = env.reset()                      # [num_envs, n_agents, obs_size]
    obs, rew, done, infos = env.step(act)  # act: [num_envs, n_agents, 10]

Action: [forward -1..1, strafe -1..1, yawDelta deg, pitchDelta deg (+down), jump, crouch, walk,
         fire, reload, slot 0=keep 1=primary 2=pistol 3=knife 4=grenade (again: next kind), moveFrac 0..1, fireFrac 0..1, attack2]
         (moveFrac/fireFrac: optional CS2-style sub-tick moments; attack2: Glock burst toggle / knife stab;
         shorter actions are zero-padded).
Envs auto-reset; infos[i]["final_obs"] on done.
"""
import http.client
import json
import random
import time

try:
    import numpy as np
except ImportError:  # works without numpy, just returns lists
    np = None


class Arena:
    def __init__(self, host="127.0.0.1", port=8080, num_envs=64, **config):
        self.conn = http.client.HTTPConnection(host, port)  # keep-alive, one socket
        r = self._post("/api/envs", {"count": num_envs, "config": config})
        self.ids, self.obs_size, self.action_size, self.n_agents = r["ids"], r["obsSize"], r["actionSize"], r["nAgents"]

    def _post(self, path, body):
        self.conn.request("POST", path, json.dumps(body), {"content-type": "application/json"})
        r = json.loads(self.conn.getresponse().read())
        if "error" in r:
            raise RuntimeError(r["error"])
        return r

    def _arr(self, x):
        return np.asarray(x, dtype=np.float32) if np else x

    def reset(self, seed=None):
        return self._arr(self._post("/api/reset", {"ids": self.ids, "seed": seed})["obs"])

    def step(self, actions):
        acts = actions.tolist() if hasattr(actions, "tolist") else actions
        r = self._post("/api/step", {"ids": self.ids, "actions": acts})
        dones = np.asarray(r["dones"]) if np else r["dones"]
        return self._arr(r["obs"]), self._arr(r["rewards"]), dones, r["infos"]

    def close(self):
        self._post("/api/close", {"ids": self.ids})
        self.conn.close()


if __name__ == "__main__":  # smoke test + throughput: random actions
    env = Arena(num_envs=256)
    print("envs", len(env.ids), "agents/env", env.n_agents, "obs", env.obs_size, "act", env.action_size)
    env.reset(seed=0)
    rand = lambda: [random.uniform(-1, 1), random.uniform(-1, 1), random.uniform(-10, 10), random.uniform(-3, 3),
                    0, 0, 0, random.random() < 0.3, 0, 0]
    t, steps, episodes = time.time(), 50, 0
    for _ in range(steps):
        obs, rew, done, infos = env.step([[rand() for _ in range(env.n_agents)] for _ in env.ids])
        episodes += int(sum(done))
    dt = time.time() - t
    print(f"{steps * len(env.ids) / dt:.0f} env-steps/s ({steps * len(env.ids) * 4 / dt:.0f} ticks/s), episodes done: {episodes}")
    env.close()
