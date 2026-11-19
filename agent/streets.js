// The street graph the robot drives on: downtown Austin, hard-coded.
//
//   Nodes  real intersections, with coordinates from OpenStreetMap (© OpenStreetMap
//          contributors, ODbL). Covered: Lavaca, Colorado, Congress, Brazos, San Jacinto
//          and Trinity, crossed with Cesar Chavez and 2nd through 11th St; Congress Ave
//          over the bridge and down South Congress; and E 6th St east past I-35.
//          Three "midblock" nodes break up the two long stretches (the bridge and South
//          Congress between Riverside and Academy) so no step is longer than a block.
//   Edges  only between two nodes joined directly by one street segment, with that street's name.
//   Chargers  each charger is a node joined to its nearest intersection.
//
// Everything is in this file: routing makes no network calls, so it works offline.
// The data was built once from OpenStreetMap; the routing code below it is hand-written.

export const NODES = {
  "lavaca-st-and-w-11th-st": { name: "Lavaca St & W 11th St", lat: 30.273397, lng: -97.743473, kind: "intersection" },
  "colorado-st-and-w-11th-st": { name: "Colorado St & W 11th St", lat: 30.273097, lng: -97.742383, kind: "intersection" },
  "congress-ave-and-11th-st": { name: "Congress Ave & 11th St", lat: 30.272733, lng: -97.741086, kind: "intersection" },
  "lavaca-st-and-w-10th-st": { name: "Lavaca St & W 10th St", lat: 30.272458, lng: -97.743832, kind: "intersection" },
  "brazos-st-and-e-11th-st": { name: "Brazos St & E 11th St", lat: 30.272361, lng: -97.739745, kind: "intersection" },
  "colorado-st-and-w-10th-st": { name: "Colorado St & W 10th St", lat: 30.272151, lng: -97.74274, kind: "intersection" },
  "san-jacinto-blvd-and-e-11th-st": { name: "San Jacinto Blvd & E 11th St", lat: 30.272057, lng: -97.738659, kind: "intersection" },
  "congress-ave-and-10th-st": { name: "Congress Ave & 10th St", lat: 30.271801, lng: -97.741431, kind: "intersection" },
  "trinity-st-and-e-11th-st": { name: "Trinity St & E 11th St", lat: 30.271764, lng: -97.737618, kind: "intersection" },
  "lavaca-st-and-w-9th-st": { name: "Lavaca St & W 9th St", lat: 30.271541, lng: -97.744181, kind: "intersection" },
  "brazos-st-and-e-10th-st": { name: "Brazos St & E 10th St", lat: 30.271432, lng: -97.74011, kind: "intersection" },
  "colorado-st-and-w-9th-st": { name: "Colorado St & W 9th St", lat: 30.271234, lng: -97.743081, kind: "intersection" },
  "san-jacinto-blvd-and-e-10th-st": { name: "San Jacinto Blvd & E 10th St", lat: 30.271125, lng: -97.739008, kind: "intersection" },
  "congress-ave-and-9th-st": { name: "Congress Ave & 9th St", lat: 30.270844, lng: -97.741772, kind: "intersection" },
  "trinity-st-and-e-10th-st": { name: "Trinity St & E 10th St", lat: 30.270838, lng: -97.737967, kind: "intersection" },
  "lavaca-st-and-w-8th-st": { name: "Lavaca St & W 8th St", lat: 30.270589, lng: -97.744537, kind: "intersection" },
  "brazos-st-and-e-9th-st": { name: "Brazos St & E 9th St", lat: 30.270482, lng: -97.740455, kind: "intersection" },
  "colorado-st-and-w-8th-st": { name: "Colorado St & W 8th St", lat: 30.270282, lng: -97.743437, kind: "intersection" },
  "san-jacinto-blvd-and-e-9th-st": { name: "San Jacinto Blvd & E 9th St", lat: 30.270186, lng: -97.739359, kind: "intersection" },
  "congress-ave-and-8th-st": { name: "Congress Ave & 8th St", lat: 30.269914, lng: -97.742117, kind: "intersection" },
  "trinity-st-and-e-9th-st": { name: "Trinity St & E 9th St", lat: 30.269905, lng: -97.738327, kind: "intersection" },
  "lavaca-st-and-w-7th-st": { name: "Lavaca St & W 7th St", lat: 30.269672, lng: -97.74488, kind: "intersection" },
  "brazos-st-and-e-8th-st": { name: "Brazos St & E 8th St", lat: 30.269545, lng: -97.740799, kind: "intersection" },
  "colorado-st-and-w-7th-st": { name: "Colorado St & W 7th St", lat: 30.269365, lng: -97.74378, kind: "intersection" },
  "san-jacinto-blvd-and-e-8th-st": { name: "San Jacinto Blvd & E 8th St", lat: 30.269243, lng: -97.739712, kind: "intersection" },
  "congress-ave-and-7th-st": { name: "Congress Ave & 7th St", lat: 30.268996, lng: -97.742461, kind: "intersection" },
  "trinity-st-and-e-8th-st": { name: "Trinity St & E 8th St", lat: 30.268957, lng: -97.738685, kind: "intersection" },
  "lavaca-st-and-w-6th-st": { name: "Lavaca St & W 6th St", lat: 30.268747, lng: -97.745226, kind: "intersection" },
  "brazos-st-and-e-7th-st": { name: "Brazos St & E 7th St", lat: 30.268624, lng: -97.741138, kind: "intersection" },
  "colorado-st-and-w-6th-st": { name: "Colorado St & W 6th St", lat: 30.26844, lng: -97.744126, kind: "intersection" },
  "san-jacinto-blvd-and-e-7th-st": { name: "San Jacinto Blvd & E 7th St", lat: 30.268325, lng: -97.740055, kind: "intersection" },
  "congress-ave-and-6th-st": { name: "Congress Ave & 6th St", lat: 30.268072, lng: -97.742806, kind: "intersection" },
  "trinity-st-and-e-7th-st": { name: "Trinity St & E 7th St", lat: 30.268034, lng: -97.739022, kind: "intersection" },
  "lavaca-st-and-w-5th-st": { name: "Lavaca St & W 5th St", lat: 30.267814, lng: -97.745575, kind: "intersection" },
  "brazos-st-and-e-6th-st": { name: "Brazos St & E 6th St", lat: 30.267698, lng: -97.741468, kind: "intersection" },
  "colorado-st-and-w-5th-st": { name: "Colorado St & W 5th St", lat: 30.267507, lng: -97.744475, kind: "intersection" },
  "san-jacinto-blvd-and-e-6th-st": { name: "San Jacinto Blvd & E 6th St", lat: 30.267401, lng: -97.740401, kind: "intersection" },
  "congress-ave-and-5th-st": { name: "Congress Ave & 5th St", lat: 30.267139, lng: -97.743156, kind: "intersection" },
  "trinity-st-and-e-6th-st": { name: "Trinity St & E 6th St", lat: 30.267104, lng: -97.739348, kind: "intersection" },
  "lavaca-st-and-w-4th-st": { name: "Lavaca St & W 4th St", lat: 30.266878, lng: -97.745925, kind: "intersection" },
  "e-6th-st-and-neches-st": { name: "E 6th St & Neches St", lat: 30.266799, lng: -97.738267, kind: "intersection" },
  "brazos-st-and-e-5th-st": { name: "Brazos St & E 5th St", lat: 30.266764, lng: -97.741814, kind: "intersection" },
  "colorado-st-and-w-4th-st": { name: "Colorado St & W 4th St", lat: 30.266571, lng: -97.744825, kind: "intersection" },
  "e-6th-st-and-red-river-st": { name: "E 6th St & Red River St", lat: 30.26649, lng: -97.737191, kind: "intersection" },
  "san-jacinto-blvd-and-e-5th-st": { name: "San Jacinto Blvd & E 5th St", lat: 30.266467, lng: -97.74075, kind: "intersection" },
  "congress-ave-and-4th-st": { name: "Congress Ave & 4th St", lat: 30.266203, lng: -97.743506, kind: "intersection" },
  "e-6th-st-and-sabine-st": { name: "E 6th St & Sabine St", lat: 30.266201, lng: -97.736161, kind: "intersection" },
  "trinity-st-and-e-5th-st": { name: "Trinity St & E 5th St", lat: 30.266165, lng: -97.739668, kind: "intersection" },
  "lavaca-st-and-w-3rd-st": { name: "Lavaca St & W 3rd St", lat: 30.265945, lng: -97.746274, kind: "intersection" },
  "e-6th-st-and-i-35-frontage-road-west-side": { name: "E 6th St & I-35 frontage road (west side)", lat: 30.265886, lng: -97.735038, kind: "intersection" },
  "brazos-st-and-e-4th-st": { name: "Brazos St & E 4th St", lat: 30.265829, lng: -97.742164, kind: "intersection" },
  "e-6th-st-and-i-35-frontage-road-east-side": { name: "E 6th St & I-35 frontage road (east side)", lat: 30.265654, lng: -97.734176, kind: "intersection" },
  "colorado-st-and-w-3rd-st": { name: "Colorado St & W 3rd St", lat: 30.265639, lng: -97.745174, kind: "intersection" },
  "san-jacinto-blvd-and-e-4th-st": { name: "San Jacinto Blvd & E 4th St", lat: 30.265532, lng: -97.7411, kind: "intersection" },
  "e-6th-st-and-brushy-st": { name: "E 6th St & Brushy St", lat: 30.265471, lng: -97.733567, kind: "intersection" },
  "congress-ave-and-3rd-st": { name: "Congress Ave & 3rd St", lat: 30.265273, lng: -97.743853, kind: "intersection" },
  "trinity-st-and-e-4th-st": { name: "Trinity St & E 4th St", lat: 30.26523, lng: -97.740018, kind: "intersection" },
  "e-6th-st-and-san-marcos-st": { name: "E 6th St & San Marcos St", lat: 30.26512, lng: -97.732517, kind: "intersection" },
  "lavaca-st-and-w-2nd-st": { name: "Lavaca St & W 2nd St", lat: 30.264995, lng: -97.74663, kind: "intersection" },
  "brazos-st-and-e-3rd-st": { name: "Brazos St & E 3rd St", lat: 30.264895, lng: -97.742513, kind: "intersection" },
  "e-6th-st-and-medina-st": { name: "E 6th St & Medina St", lat: 30.264771, lng: -97.731512, kind: "intersection" },
  "colorado-st-and-w-2nd-st": { name: "Colorado St & W 2nd St", lat: 30.264688, lng: -97.74553, kind: "intersection" },
  "san-jacinto-blvd-and-e-3rd-st": { name: "San Jacinto Blvd & E 3rd St", lat: 30.264595, lng: -97.741451, kind: "intersection" },
  "e-6th-st-and-waller-st": { name: "E 6th St & Waller St", lat: 30.264424, lng: -97.73051, kind: "intersection" },
  "congress-ave-and-2nd-st": { name: "Congress Ave & 2nd St", lat: 30.26432, lng: -97.744212, kind: "intersection" },
  "trinity-st-and-e-3rd-st": { name: "Trinity St & E 3rd St", lat: 30.264292, lng: -97.740369, kind: "intersection" },
  "lavaca-st-and-w-cesar-chavez-st": { name: "Lavaca St & W Cesar Chavez St", lat: 30.264076, lng: -97.746987, kind: "intersection" },
  "brazos-st-and-e-2nd-st": { name: "Brazos St & E 2nd St", lat: 30.263945, lng: -97.742869, kind: "intersection" },
  "colorado-st-and-w-cesar-chavez-st": { name: "Colorado St & W Cesar Chavez St", lat: 30.263766, lng: -97.745875, kind: "intersection" },
  "san-jacinto-blvd-and-e-2nd-st": { name: "San Jacinto Blvd & E 2nd St", lat: 30.263648, lng: -97.741805, kind: "intersection" },
  "congress-ave-and-cesar-chavez-st": { name: "Congress Ave & Cesar Chavez St", lat: 30.263396, lng: -97.744556, kind: "intersection" },
  "trinity-st-and-e-2nd-st": { name: "Trinity St & E 2nd St", lat: 30.263346, lng: -97.740722, kind: "intersection" },
  "brazos-st-and-e-cesar-chavez-st": { name: "Brazos St & E Cesar Chavez St", lat: 30.263022, lng: -97.743214, kind: "intersection" },
  "san-jacinto-blvd-and-e-cesar-chavez-st": { name: "San Jacinto Blvd & E Cesar Chavez St", lat: 30.262725, lng: -97.742151, kind: "intersection" },
  "congress-ave-bridge-north-end": { name: "Congress Ave Bridge, north end", lat: 30.262643, lng: -97.744825, kind: "intersection" },
  "trinity-st-and-e-cesar-chavez-st": { name: "Trinity St & E Cesar Chavez St", lat: 30.262423, lng: -97.741067, kind: "intersection" },
  "s-congress-ave-and-barton-springs-rd": { name: "S Congress Ave & Barton Springs Rd", lat: 30.258921, lng: -97.746231, kind: "intersection" },
  "s-congress-ave-and-riverside-dr": { name: "S Congress Ave & Riverside Dr", lat: 30.257144, lng: -97.746875, kind: "intersection" },
  "s-congress-ave-and-academy-dr": { name: "S Congress Ave & Academy Dr", lat: 30.252228, lng: -97.748692, kind: "intersection" },
  "s-congress-ave-and-the-circle": { name: "S Congress Ave & The Circle", lat: 30.251133, lng: -97.749095, kind: "intersection" },
  "s-congress-ave-and-gibson-st": { name: "S Congress Ave & Gibson St", lat: 30.249913, lng: -97.749542, kind: "intersection" },
  "s-congress-ave-and-elizabeth-st": { name: "S Congress Ave & Elizabeth St", lat: 30.248909, lng: -97.749934, kind: "intersection" },
  "midblock-1": { name: "Congress Ave Bridge, mid-span", lat: 30.26078, lng: -97.745521, kind: "midblock" },
  "midblock-3": { name: "S Congress Ave, between Riverside Dr and Academy Dr (1 of 2)", lat: 30.255512, lng: -97.747503, kind: "midblock" },
  "midblock-2": { name: "S Congress Ave, between Riverside Dr and Academy Dr (2 of 2)", lat: 30.25387, lng: -97.748098, kind: "midblock" },
  "charger-001": { name: "Congress Ave Robot Dock", lat: 30.2682, lng: -97.7429, kind: "charger" },
  "charger-003": { name: "East 6th St Dock", lat: 30.2647, lng: -97.731, kind: "charger" },
  "charger-002": { name: "South Congress Charging Bay", lat: 30.2497, lng: -97.7494, kind: "charger" },
};

/** [from, to, street]: the two nodes are next to each other on that street. Streets run both ways. */
export const EDGES = [
  ["colorado-st-and-w-10th-st", "lavaca-st-and-w-10th-st", "10th St"],
  ["congress-ave-and-10th-st", "brazos-st-and-e-10th-st", "10th St"],
  ["congress-ave-and-10th-st", "colorado-st-and-w-10th-st", "10th St"],
  ["brazos-st-and-e-10th-st", "san-jacinto-blvd-and-e-10th-st", "10th St"],
  ["trinity-st-and-e-10th-st", "san-jacinto-blvd-and-e-10th-st", "10th St"],
  ["lavaca-st-and-w-11th-st", "colorado-st-and-w-11th-st", "11th St"],
  ["congress-ave-and-11th-st", "colorado-st-and-w-11th-st", "11th St"],
  ["congress-ave-and-11th-st", "brazos-st-and-e-11th-st", "11th St"],
  ["brazos-st-and-e-11th-st", "san-jacinto-blvd-and-e-11th-st", "11th St"],
  ["san-jacinto-blvd-and-e-11th-st", "trinity-st-and-e-11th-st", "11th St"],
  ["colorado-st-and-w-2nd-st", "lavaca-st-and-w-2nd-st", "2nd St"],
  ["congress-ave-and-2nd-st", "brazos-st-and-e-2nd-st", "2nd St"],
  ["congress-ave-and-2nd-st", "colorado-st-and-w-2nd-st", "2nd St"],
  ["brazos-st-and-e-2nd-st", "san-jacinto-blvd-and-e-2nd-st", "2nd St"],
  ["trinity-st-and-e-2nd-st", "san-jacinto-blvd-and-e-2nd-st", "2nd St"],
  ["colorado-st-and-w-3rd-st", "lavaca-st-and-w-3rd-st", "3rd St"],
  ["congress-ave-and-3rd-st", "brazos-st-and-e-3rd-st", "3rd St"],
  ["congress-ave-and-3rd-st", "colorado-st-and-w-3rd-st", "3rd St"],
  ["brazos-st-and-e-3rd-st", "san-jacinto-blvd-and-e-3rd-st", "3rd St"],
  ["san-jacinto-blvd-and-e-3rd-st", "trinity-st-and-e-3rd-st", "3rd St"],
  ["colorado-st-and-w-4th-st", "lavaca-st-and-w-4th-st", "4th St"],
  ["congress-ave-and-4th-st", "brazos-st-and-e-4th-st", "4th St"],
  ["congress-ave-and-4th-st", "colorado-st-and-w-4th-st", "4th St"],
  ["brazos-st-and-e-4th-st", "san-jacinto-blvd-and-e-4th-st", "4th St"],
  ["san-jacinto-blvd-and-e-4th-st", "trinity-st-and-e-4th-st", "4th St"],
  ["lavaca-st-and-w-5th-st", "colorado-st-and-w-5th-st", "5th St"],
  ["congress-ave-and-5th-st", "colorado-st-and-w-5th-st", "5th St"],
  ["congress-ave-and-5th-st", "brazos-st-and-e-5th-st", "5th St"],
  ["brazos-st-and-e-5th-st", "san-jacinto-blvd-and-e-5th-st", "5th St"],
  ["san-jacinto-blvd-and-e-5th-st", "trinity-st-and-e-5th-st", "5th St"],
  ["lavaca-st-and-w-6th-st", "colorado-st-and-w-6th-st", "6th St"],
  ["congress-ave-and-6th-st", "brazos-st-and-e-6th-st", "6th St"],
  ["congress-ave-and-6th-st", "colorado-st-and-w-6th-st", "6th St"],
  ["brazos-st-and-e-6th-st", "san-jacinto-blvd-and-e-6th-st", "6th St"],
  ["san-jacinto-blvd-and-e-6th-st", "trinity-st-and-e-6th-st", "6th St"],
  ["trinity-st-and-e-6th-st", "e-6th-st-and-neches-st", "6th St"],
  ["e-6th-st-and-neches-st", "e-6th-st-and-red-river-st", "6th St"],
  ["e-6th-st-and-red-river-st", "e-6th-st-and-sabine-st", "6th St"],
  ["e-6th-st-and-i-35-frontage-road-west-side", "e-6th-st-and-i-35-frontage-road-east-side", "6th St"],
  ["e-6th-st-and-i-35-frontage-road-west-side", "e-6th-st-and-sabine-st", "6th St"],
  ["e-6th-st-and-i-35-frontage-road-east-side", "e-6th-st-and-brushy-st", "6th St"],
  ["e-6th-st-and-brushy-st", "e-6th-st-and-san-marcos-st", "6th St"],
  ["e-6th-st-and-san-marcos-st", "e-6th-st-and-medina-st", "6th St"],
  ["e-6th-st-and-medina-st", "e-6th-st-and-waller-st", "6th St"],
  ["colorado-st-and-w-7th-st", "lavaca-st-and-w-7th-st", "7th St"],
  ["congress-ave-and-7th-st", "colorado-st-and-w-7th-st", "7th St"],
  ["congress-ave-and-7th-st", "brazos-st-and-e-7th-st", "7th St"],
  ["brazos-st-and-e-7th-st", "san-jacinto-blvd-and-e-7th-st", "7th St"],
  ["trinity-st-and-e-7th-st", "san-jacinto-blvd-and-e-7th-st", "7th St"],
  ["colorado-st-and-w-8th-st", "lavaca-st-and-w-8th-st", "8th St"],
  ["congress-ave-and-8th-st", "brazos-st-and-e-8th-st", "8th St"],
  ["congress-ave-and-8th-st", "colorado-st-and-w-8th-st", "8th St"],
  ["san-jacinto-blvd-and-e-8th-st", "brazos-st-and-e-8th-st", "8th St"],
  ["trinity-st-and-e-8th-st", "san-jacinto-blvd-and-e-8th-st", "8th St"],
  ["lavaca-st-and-w-9th-st", "colorado-st-and-w-9th-st", "9th St"],
  ["congress-ave-and-9th-st", "colorado-st-and-w-9th-st", "9th St"],
  ["congress-ave-and-9th-st", "brazos-st-and-e-9th-st", "9th St"],
  ["brazos-st-and-e-9th-st", "san-jacinto-blvd-and-e-9th-st", "9th St"],
  ["brazos-st-and-e-11th-st", "brazos-st-and-e-10th-st", "Brazos St"],
  ["brazos-st-and-e-9th-st", "brazos-st-and-e-8th-st", "Brazos St"],
  ["brazos-st-and-e-9th-st", "brazos-st-and-e-10th-st", "Brazos St"],
  ["brazos-st-and-e-8th-st", "brazos-st-and-e-7th-st", "Brazos St"],
  ["brazos-st-and-e-6th-st", "brazos-st-and-e-5th-st", "Brazos St"],
  ["brazos-st-and-e-6th-st", "brazos-st-and-e-7th-st", "Brazos St"],
  ["brazos-st-and-e-4th-st", "brazos-st-and-e-5th-st", "Brazos St"],
  ["brazos-st-and-e-4th-st", "brazos-st-and-e-3rd-st", "Brazos St"],
  ["brazos-st-and-e-3rd-st", "brazos-st-and-e-2nd-st", "Brazos St"],
  ["brazos-st-and-e-cesar-chavez-st", "brazos-st-and-e-2nd-st", "Brazos St"],
  ["colorado-st-and-w-cesar-chavez-st", "lavaca-st-and-w-cesar-chavez-st", "Cesar Chavez St"],
  ["congress-ave-and-cesar-chavez-st", "colorado-st-and-w-cesar-chavez-st", "Cesar Chavez St"],
  ["congress-ave-and-cesar-chavez-st", "brazos-st-and-e-cesar-chavez-st", "Cesar Chavez St"],
  ["brazos-st-and-e-cesar-chavez-st", "san-jacinto-blvd-and-e-cesar-chavez-st", "Cesar Chavez St"],
  ["san-jacinto-blvd-and-e-cesar-chavez-st", "trinity-st-and-e-cesar-chavez-st", "Cesar Chavez St"],
  ["charger-001", "congress-ave-and-6th-st", "charger"],
  ["charger-003", "e-6th-st-and-medina-st", "charger"],
  ["charger-002", "s-congress-ave-and-gibson-st", "charger"],
  ["colorado-st-and-w-10th-st", "colorado-st-and-w-9th-st", "Colorado St"],
  ["colorado-st-and-w-8th-st", "colorado-st-and-w-9th-st", "Colorado St"],
  ["colorado-st-and-w-8th-st", "colorado-st-and-w-7th-st", "Colorado St"],
  ["colorado-st-and-w-7th-st", "colorado-st-and-w-6th-st", "Colorado St"],
  ["colorado-st-and-w-6th-st", "colorado-st-and-w-5th-st", "Colorado St"],
  ["colorado-st-and-w-4th-st", "colorado-st-and-w-5th-st", "Colorado St"],
  ["colorado-st-and-w-4th-st", "colorado-st-and-w-3rd-st", "Colorado St"],
  ["colorado-st-and-w-2nd-st", "colorado-st-and-w-3rd-st", "Colorado St"],
  ["colorado-st-and-w-2nd-st", "colorado-st-and-w-cesar-chavez-st", "Colorado St"],
  ["congress-ave-and-10th-st", "congress-ave-and-11th-st", "Congress Ave"],
  ["congress-ave-and-9th-st", "congress-ave-and-10th-st", "Congress Ave"],
  ["congress-ave-and-8th-st", "congress-ave-and-9th-st", "Congress Ave"],
  ["congress-ave-and-8th-st", "congress-ave-and-7th-st", "Congress Ave"],
  ["congress-ave-and-6th-st", "congress-ave-and-5th-st", "Congress Ave"],
  ["congress-ave-and-6th-st", "congress-ave-and-7th-st", "Congress Ave"],
  ["congress-ave-and-4th-st", "congress-ave-and-5th-st", "Congress Ave"],
  ["congress-ave-and-4th-st", "congress-ave-and-3rd-st", "Congress Ave"],
  ["congress-ave-and-2nd-st", "congress-ave-and-3rd-st", "Congress Ave"],
  ["congress-ave-and-cesar-chavez-st", "congress-ave-and-2nd-st", "Congress Ave"],
  ["congress-ave-bridge-north-end", "congress-ave-and-cesar-chavez-st", "Congress Ave"],
  ["congress-ave-bridge-north-end", "midblock-1", "Congress Ave"],
  ["midblock-1", "s-congress-ave-and-barton-springs-rd", "Congress Ave"],
  ["s-congress-ave-and-barton-springs-rd", "s-congress-ave-and-riverside-dr", "Congress Ave"],
  ["midblock-3", "s-congress-ave-and-riverside-dr", "Congress Ave"],
  ["midblock-2", "midblock-3", "Congress Ave"],
  ["s-congress-ave-and-academy-dr", "midblock-2", "Congress Ave"],
  ["s-congress-ave-and-academy-dr", "s-congress-ave-and-the-circle", "Congress Ave"],
  ["s-congress-ave-and-the-circle", "s-congress-ave-and-gibson-st", "Congress Ave"],
  ["s-congress-ave-and-gibson-st", "s-congress-ave-and-elizabeth-st", "Congress Ave"],
  ["lavaca-st-and-w-10th-st", "lavaca-st-and-w-11th-st", "Lavaca St"],
  ["lavaca-st-and-w-10th-st", "lavaca-st-and-w-9th-st", "Lavaca St"],
  ["lavaca-st-and-w-8th-st", "lavaca-st-and-w-7th-st", "Lavaca St"],
  ["lavaca-st-and-w-8th-st", "lavaca-st-and-w-9th-st", "Lavaca St"],
  ["lavaca-st-and-w-7th-st", "lavaca-st-and-w-6th-st", "Lavaca St"],
  ["lavaca-st-and-w-5th-st", "lavaca-st-and-w-6th-st", "Lavaca St"],
  ["lavaca-st-and-w-4th-st", "lavaca-st-and-w-5th-st", "Lavaca St"],
  ["lavaca-st-and-w-4th-st", "lavaca-st-and-w-3rd-st", "Lavaca St"],
  ["lavaca-st-and-w-2nd-st", "lavaca-st-and-w-3rd-st", "Lavaca St"],
  ["lavaca-st-and-w-2nd-st", "lavaca-st-and-w-cesar-chavez-st", "Lavaca St"],
  ["san-jacinto-blvd-and-e-11th-st", "san-jacinto-blvd-and-e-10th-st", "San Jacinto Blvd"],
  ["san-jacinto-blvd-and-e-9th-st", "san-jacinto-blvd-and-e-8th-st", "San Jacinto Blvd"],
  ["san-jacinto-blvd-and-e-9th-st", "san-jacinto-blvd-and-e-10th-st", "San Jacinto Blvd"],
  ["san-jacinto-blvd-and-e-8th-st", "san-jacinto-blvd-and-e-7th-st", "San Jacinto Blvd"],
  ["san-jacinto-blvd-and-e-6th-st", "san-jacinto-blvd-and-e-7th-st", "San Jacinto Blvd"],
  ["san-jacinto-blvd-and-e-6th-st", "san-jacinto-blvd-and-e-5th-st", "San Jacinto Blvd"],
  ["san-jacinto-blvd-and-e-4th-st", "san-jacinto-blvd-and-e-5th-st", "San Jacinto Blvd"],
  ["san-jacinto-blvd-and-e-4th-st", "san-jacinto-blvd-and-e-3rd-st", "San Jacinto Blvd"],
  ["san-jacinto-blvd-and-e-3rd-st", "san-jacinto-blvd-and-e-2nd-st", "San Jacinto Blvd"],
  ["san-jacinto-blvd-and-e-cesar-chavez-st", "san-jacinto-blvd-and-e-2nd-st", "San Jacinto Blvd"],
  ["trinity-st-and-e-11th-st", "trinity-st-and-e-10th-st", "Trinity St"],
  ["trinity-st-and-e-9th-st", "trinity-st-and-e-10th-st", "Trinity St"],
  ["trinity-st-and-e-9th-st", "trinity-st-and-e-8th-st", "Trinity St"],
  ["trinity-st-and-e-7th-st", "trinity-st-and-e-8th-st", "Trinity St"],
  ["trinity-st-and-e-6th-st", "trinity-st-and-e-5th-st", "Trinity St"],
  ["trinity-st-and-e-6th-st", "trinity-st-and-e-7th-st", "Trinity St"],
  ["trinity-st-and-e-4th-st", "trinity-st-and-e-3rd-st", "Trinity St"],
  ["trinity-st-and-e-4th-st", "trinity-st-and-e-5th-st", "Trinity St"],
  ["trinity-st-and-e-3rd-st", "trinity-st-and-e-2nd-st", "Trinity St"],
  ["trinity-st-and-e-cesar-chavez-st", "trinity-st-and-e-2nd-st", "Trinity St"],
];

// --- Geometry ---------------------------------------------------------------------------------

const EARTH_RADIUS_M = 6_371_000;
const toRadians = (degrees) => (degrees * Math.PI) / 180;

/** Distance in metres between two { lat, lng } points (haversine). */
export function metersBetween(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// --- The graph ----------------------------------------------------------------------------------

/** node id -> [{ to, meters, street }] */
const NEIGHBOURS = {};
for (const id of Object.keys(NODES)) NEIGHBOURS[id] = [];
for (const [a, b, street] of EDGES) {
  const meters = metersBetween(NODES[a], NODES[b]);
  NEIGHBOURS[a].push({ to: b, meters, street });
  NEIGHBOURS[b].push({ to: a, meters, street });
}

/** Are these two nodes directly joined by a street segment? */
export function isEdge(a, b) {
  return NEIGHBOURS[a]?.some((edge) => edge.to === b) ?? false;
}

/** The node closest to a location. `kinds` limits the search, e.g. ["intersection"]. */
export function nearestNode(location, kinds = null) {
  let best = null;
  let bestMeters = Infinity;
  for (const [id, node] of Object.entries(NODES)) {
    if (kinds && !kinds.includes(node.kind)) continue;
    const meters = metersBetween(location, node);
    if (meters < bestMeters) [best, bestMeters] = [id, meters];
  }
  return best;
}

/**
 * Shortest route between two nodes along the streets (Dijkstra, by distance).
 * Returns { nodes: [from, ..., to], meters }, or null if there is no way through.
 * A charger is only ever an end point: routes do not pass through one.
 */
export function shortestPath(from, to) {
  if (!NODES[from] || !NODES[to]) return null;
  const distance = { [from]: 0 };
  const previous = {};
  const done = new Set();
  while (true) {
    // The closest node not yet settled. (A plain scan: the graph has under a hundred nodes.)
    let current = null;
    for (const id in distance) if (!done.has(id) && (current === null || distance[id] < distance[current])) current = id;
    if (current === null) return null;
    if (current === to) break;
    done.add(current);
    if (NODES[current].kind === "charger" && current !== from) continue;
    for (const edge of NEIGHBOURS[current]) {
      const candidate = distance[current] + edge.meters;
      if (distance[edge.to] === undefined || candidate < distance[edge.to]) {
        distance[edge.to] = candidate;
        previous[edge.to] = current;
      }
    }
  }
  const nodes = [to];
  while (nodes[0] !== from) nodes.unshift(previous[nodes[0]]);
  return { nodes, meters: distance[to] };
}

/** The coordinates of a list of node ids, as { lat, lng, node }. */
export function pointsOf(nodeIds) {
  return nodeIds.map((id) => ({ lat: NODES[id].lat, lng: NODES[id].lng, node: id }));
}

// --- The delivery loop ----------------------------------------------------------------------------

/** The robot's delivery stops, in order. It drives from each to the next along the streets, then round again. */
export const DELIVERY_STOPS = [
  "congress-ave-and-6th-st",
  "trinity-st-and-e-6th-st",
  "trinity-st-and-e-cesar-chavez-st",
  "congress-ave-and-cesar-chavez-st",
  "s-congress-ave-and-riverside-dr", // over the Congress Ave bridge and back
  "lavaca-st-and-w-cesar-chavez-st",
  "lavaca-st-and-w-9th-st",
  "congress-ave-and-9th-st",
];

/** The whole loop as node ids, following the streets: stop 0 -> stop 1 -> ... -> back to stop 0. */
export function deliveryLoopNodes(stops = DELIVERY_STOPS) {
  const loop = [stops[0]];
  for (let i = 0; i < stops.length; i++) loop.push(...shortestPath(stops[i], stops[(i + 1) % stops.length]).nodes.slice(1));
  return loop;
}
